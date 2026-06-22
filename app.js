/* ============================================================
   Apuestas — App (vanilla JS + Supabase, sin build)
   ============================================================ */

// ---------- Config / cliente Supabase ----------
const CFG = window.APP_CONFIG || {};
const CONFIGURADO =
  CFG.SUPABASE_URL && !CFG.SUPABASE_URL.includes("TU-PROYECTO") &&
  CFG.SUPABASE_ANON_KEY && !CFG.SUPABASE_ANON_KEY.includes("TU-ANON-KEY");

let sb = null;
if (CONFIGURADO) {
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
}

// ---------- Estado en memoria ----------
const PAGE_SIZE = 10;
const state = {
  tab: "partidos",
  casas: [],          // {id, nombre, bono_pct, tiene_cajeras, permite_gratis}
  casasById: {},      // id -> casa
  cajeras: [],        // {id, nombre, casa_id}
  partidos: [],       // {id, nombre, fecha, hora, resultado_ganador}
  partidosById: {},   // id -> partido
  movimientos: [],    // {id, cajera_id, tipo, monto, bono_pct, nota, creado_en}
  retirosGanancia: [],// {id, monto, nota, creado_en} — reparto de ganancias (baja el profit actual)
  apuestas: [],       // {id, partido_id, cajera, premio_cobrado, notas, lineas:[...], _partido}
  partidosColapsados: new Set(), // ids de partidos colapsados (por defecto van desplegados)
  pagina: 1,          // paginado del listado de partidos
  filtroEstado: "Pendiente",  // estado de partido ("" = todos | "Pendiente" | "Finalizado")
  filtroRep: { periodo: "todo", desde: "", hasta: "", cajera: "", montoMin: "", montoMax: "" },
};

// ---------- Helpers ----------
const num = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
};
const money = (v) =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(v || 0);
const pct = (v) => (v == null ? "—" : `${v.toFixed(2)}%`);
// Agrega "hs" al final de la hora si no lo tiene ya
const fmtHora = (h) => {
  const t = String(h ?? "").trim();
  if (!t) return "";
  return /hs/i.test(t) ? t : `${t} hs`;
};
// Convierte una hora de texto libre ("13 hs", "13:30", "9.45") a minutos del día.
// Devuelve null si no hay un número de hora reconocible (esos van al final al ordenar).
const horaAMinutos = (h) => {
  const m = String(h ?? "").trim().match(/(\d{1,2})\s*(?::|\.|h|hs)?\s*(\d{2})?/i);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  if (isNaN(hh)) return null;
  return hh * 60 + (m[2] ? parseInt(m[2], 10) : 0);
};
// Orden de partidos: por fecha ascendente (el más próximo primero) y luego por
// hora ascendente. Los que no tienen fecha/hora van al final.
const ordenarPartidos = (arr) => [...arr].sort((a, b) => {
  const fa = a.fecha || "", fb = b.fecha || "";
  if (fa !== fb) return !fa ? 1 : !fb ? -1 : (fa < fb ? -1 : 1);
  const ha = horaAMinutos(a.hora), hb = horaAMinutos(b.hora);
  if (ha == null && hb == null) return 0;
  if (ha == null) return 1;
  if (hb == null) return -1;
  return ha - hb;
});
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Fecha de hoy menos N días en formato YYYY-MM-DD
function hoyMenosDias(d) {
  const t = new Date();
  t.setDate(t.getDate() - d);
  const off = t.getTimezoneOffset() * 60000;
  return new Date(t - off).toISOString().slice(0, 10);
}

// Estado de un partido (derivado): tiene resultado => Finalizado
function estadoPartido(p) {
  return p && p.resultado_ganador ? "Finalizado" : "Pendiente";
}

// Apuestas de un partido
function apuestasDePartido(id) {
  return state.apuestas.filter((a) => a.partido_id === id);
}

// Fecha efectiva de una apuesta (vive en el partido)
function apuestaFecha(a) {
  return a._partido ? a._partido.fecha : null;
}

// Rango de fechas según el filtro de período de Reportes
function rangoReporte() {
  const f = state.filtroRep;
  let desde = null, hasta = null;
  if (f.periodo === "semana") desde = hoyMenosDias(7);
  else if (f.periodo === "mes") desde = hoyMenosDias(30);
  else if (f.periodo === "custom") { desde = f.desde || null; hasta = f.hasta || null; }
  return { desde, hasta };
}

// Aplica los filtros de la pestaña Reportes
function apuestasFiltradas() {
  const f = state.filtroRep;
  const { desde, hasta } = rangoReporte();

  return state.apuestas.filter((a) => {
    const fecha = apuestaFecha(a);
    if (desde && (!fecha || fecha < desde)) return false;
    if (hasta && (!fecha || fecha > hasta)) return false;
    if (f.cajera && a.cajera !== f.cajera) return false;
    if (f.montoMin !== "" || f.montoMax !== "") {
      const ing = calcApuesta(a).ingresado;
      if (f.montoMin !== "" && ing < num(f.montoMin)) return false;
      if (f.montoMax !== "" && ing > num(f.montoMax)) return false;
    }
    return true;
  });
}

// ---------- Cálculos ----------
function calcLinea(l) {
  const cargado = num(l.monto_cargado);
  // El bono NO se aplica en la apuesta (se da solo al depositar en la cajera): apostado = plata real.
  const apostado = cargado;
  const cuota = num(l.cuota);
  const gratis = num(l.apuesta_gratis); // apuesta gratis: NO es dinero ingresado
  // pago normal + pago de la apuesta gratis (la casa retiene el monto: gratis × (cuota − 1))
  const premio = apostado * cuota + (cuota > 0 ? gratis * (cuota - 1) : 0);
  return { cargado, apostado, premio, gratis };
}

// El estado de la apuesta se deriva del resultado del partido al que pertenece.
function calcApuesta(a) {
  const lineas = a.lineas || [];
  let ingresado = 0, apostado = 0;
  lineas.forEach((l) => { const c = calcLinea(l); ingresado += c.cargado; apostado += c.apostado; });

  const resultado = a._partido ? a._partido.resultado_ganador : null;
  const resuelto = !!resultado;

  let premioGanador = 0;
  if (resultado) {
    lineas.filter((l) => (l.resultado || "") === resultado)
          .forEach((l) => { premioGanador += calcLinea(l).premio; });
  }
  const premio = (a.premio_cobrado != null && a.premio_cobrado !== "")
    ? num(a.premio_cobrado) : premioGanador;

  // Estado derivado: si el partido no tiene resultado => Pendiente;
  // si lo tiene => Cobrado cuando hay premio (>0), si no Perdido.
  let estado, profit = null;
  if (!resuelto) {
    estado = "Pendiente";
  } else if (premio > 0) {
    estado = "Cobrado"; profit = premio - ingresado;
  } else {
    estado = "Perdido"; profit = -ingresado;
  }

  const pctv = profit != null && ingresado > 0 ? (profit / ingresado) * 100 : null;
  return { ingresado, apostado, premioGanador, premio, profit, pct: pctv, estado };
}

// Totales agregados de un partido (suma de sus apuestas)
function calcPartido(p) {
  const aps = apuestasDePartido(p.id);
  let ingresado = 0, profit = 0, profitDef = false;
  aps.forEach((a) => {
    const c = calcApuesta(a);
    ingresado += c.ingresado;
    if (c.profit != null) { profit += c.profit; profitDef = true; }
  });
  return { aps, n: aps.length, ingresado, profit, profitDef };
}

// Balance del partido: por cada resultado posible, profit total si gana ese
// resultado (sumando todas las apuestas del partido).
function balancePartido(p) {
  const aps = apuestasDePartido(p.id);
  const ingresado = aps.reduce((s, a) => s + calcApuesta(a).ingresado, 0);
  const lineas = aps.flatMap((a) => a.lineas || []);
  const resultados = [...new Set(lineas.map((l) => (l.resultado || "").trim()).filter(Boolean))];
  return resultados.map((r) => {
    const premio = lineas.filter((l) => (l.resultado || "") === r)
      .reduce((s, l) => s + calcLinea(l).premio, 0);
    const profit = premio - ingresado;
    const pctv = ingresado > 0 ? (profit / ingresado) * 100 : null;
    return { resultado: r, premio, profit, pct: pctv };
  }).sort((a, b) => b.profit - a.profit);
}

// Bono estimado contenido en una apuesta: por línea, el bono ya incluido en el
// monto apostado se "saca de adentro": monto × bp/(100+bp) (bp = bono% de la casa).
function bonoEstimadoApuesta(a) {
  return (a.lineas || []).reduce((s, l) => {
    const casa = state.casas.find((x) => x.nombre === l.casa);
    const bp = casa ? num(casa.bono_pct) : 0;
    return s + (bp > 0 ? num(l.monto_cargado) * bp / (100 + bp) : 0);
  }, 0);
}

// Bono estimado generado por un partido (suma de sus apuestas)
function bonoEstimadoPartido(p) {
  return apuestasDePartido(p.id).reduce((s, a) => s + bonoEstimadoApuesta(a), 0);
}

// HTML del balance por resultado (solo partidos pendientes con resultados cargados)
function balanceHtml(p, est) {
  if (est !== "Pendiente") return "";
  const bal = balancePartido(p);
  if (!bal.length) return "";
  return `<div class="partido-balance">
    <span class="bal-title">Balance por resultado:</span>
    ${bal.map((b) => `<span class="bal-item"><span class="bal-res">${esc(b.resultado)}</span> <b class="${b.profit >= 0 ? "pos" : "neg"}">${b.profit >= 0 ? "+" : ""}${money(b.profit)}</b>${b.pct != null ? ` <span class="muted">(${b.pct >= 0 ? "+" : ""}${b.pct.toFixed(1)}%)</span>` : ""}</span>`).join("")}
  </div>`;
}

// Premio / profit / % potencial de cada casa (si gana esa línea), sobre el total ingresado
function potencialPorCasa(a) {
  const ingresado = calcApuesta(a).ingresado;
  return (a.lineas || [])
    .map((l) => {
      const premio = calcLinea(l).premio;
      const prof = premio - ingresado;
      const pctv = ingresado > 0 ? (prof / ingresado) * 100 : null;
      return { casa: l.casa || "—", premio, prof, pct: pctv };
    })
    .filter((x) => x.premio > 0);
}

// Lista por casa de "resultado @ cuota" de una apuesta (para verlo en la fila)
function lineasApuestaHtml(a) {
  const ls = (a.lineas || []).filter((l) => l.casa || l.resultado || l.cuota != null && l.cuota !== "");
  if (!ls.length) return "—";
  return `<div class="pot-list">${ls.map((l) => {
    const cuota = (l.cuota == null || l.cuota === "") ? "—" : num(l.cuota);
    return `<div class="pot-row"><span class="pot-casa">${esc(l.casa || "—")}</span><span>${esc(l.resultado || "—")} @ ${cuota}</span></div>`;
  }).join("")}</div>`;
}

// Renderiza la lista por casa para una columna (premio | profit | pct)
function potListHtml(pot, tipo) {
  if (!pot.length) return "—";
  return `<div class="pot-list">${pot.map((p) => {
    let val = "", cls = "";
    if (tipo === "premio") { val = money(p.premio); }
    else if (tipo === "profit") { val = money(p.prof); cls = p.prof >= 0 ? "pos" : "neg"; }
    else { val = p.pct == null ? "—" : (p.pct >= 0 ? "+" : "") + p.pct.toFixed(1) + "%"; cls = p.pct == null ? "muted" : p.pct >= 0 ? "pos" : "neg"; }
    return `<div class="pot-row"><span class="pot-casa">${esc(p.casa)}</span><span class="${cls}">${val}</span></div>`;
  }).join("")}</div>`;
}

// ---------- Saldo / billetera por cajera ----------
function casaTieneCajeras(nombre) {
  const c = state.casas.find((x) => x.nombre === nombre);
  return !!(c && c.tiene_cajeras);
}

// Casa (casino) asociada a una cajera
function casaDeCajera(c) {
  return c && c.casa_id ? state.casasById[c.casa_id] : null;
}

// Efecto de un movimiento manual sobre el saldo (carga suma con bono, retiro resta)
function efectoMovimiento(m) {
  if (m.tipo === "Carga") return num(m.monto) * (1 + num(m.bono_pct) / 100);
  if (m.tipo === "Retiro") return -num(m.monto);
  return 0;
}

// Dinero real que una apuesta consume de la cajera (líneas de casas con cajeras)
function debitoCajera(a) {
  return (a.lineas || [])
    .filter((l) => casaTieneCajeras(l.casa))
    .reduce((s, l) => s + num(l.monto_cargado), 0);
}

// Premio que cobra la cajera si ganó una línea de una casa con cajeras
function creditoCajera(a) {
  const res = a._partido ? a._partido.resultado_ganador : null;
  if (!res) return 0;
  return (a.lineas || [])
    .filter((l) => casaTieneCajeras(l.casa) && (l.resultado || "") === res)
    .reduce((s, l) => s + calcLinea(l).premio, 0);
}

// Saldo y desglose de una cajera ({id, nombre})
function resumenCajera(c) {
  const movs = state.movimientos.filter((m) => m.cajera_id === c.id);
  const cargado = movs.filter((m) => m.tipo === "Carga").reduce((s, m) => s + efectoMovimiento(m), 0);
  const retirado = movs.filter((m) => m.tipo === "Retiro").reduce((s, m) => s + num(m.monto), 0);

  const aps = state.apuestas.filter((a) => a.cajera === c.nombre);
  const apostado = aps.reduce((s, a) => s + debitoCajera(a), 0);
  const ganado = aps.reduce((s, a) => s + creditoCajera(a), 0);

  // Apostar descuenta; ganar y cargar suman; retirar resta.
  // El saldo nunca queda negativo: piso en 0.
  const saldo = Math.max(0, cargado + ganado - apostado - retirado);
  return { saldo, cargado, retirado, apostado, ganado, nApuestas: aps.length };
}

// Última actividad de una cajera (ms): lo más reciente entre sus movimientos
// (cargas/retiros/ganancias) y sus apuestas. 0 si nunca tuvo movimiento.
function ultimaActividadCajera(c) {
  let max = 0;
  const considerar = (fecha) => {
    const t = fecha ? Date.parse(fecha) : NaN;
    if (!isNaN(t) && t > max) max = t;
  };
  state.movimientos.forEach((m) => { if (m.cajera_id === c.id) considerar(m.creado_en); });
  state.apuestas.forEach((a) => { if (a.cajera === c.nombre) considerar(a.creado_en); });
  return max;
}

// Partidos pendientes (sin resolver) en los que la cajera tiene plata apostada.
// Devuelve [{partido, monto}] con el monto actual apostado en ese partido (líneas con cajera).
function partidosPendientesCajera(c) {
  const map = new Map();
  state.apuestas
    .filter((a) => a.cajera === c.nombre && a._partido && !a._partido.resultado_ganador)
    .forEach((a) => {
      const monto = debitoCajera(a);
      if (monto <= 0) return;
      const p = a._partido;
      const cur = map.get(p.id) || { partido: p, monto: 0 };
      cur.monto += monto;
      map.set(p.id, cur);
    });
  return [...map.values()].sort((a, b) => b.monto - a.monto);
}

// ---------- Indicador de carga / feedback ----------
// Contador de operaciones en curso: muestra la barra de progreso global y
// el cursor "busy" mientras haya alguna acción pendiente (red).
let _busy = 0;
let _tmpSeq = 0; // ids temporales para filas optimistas
function setBusy(on) {
  _busy = Math.max(0, _busy + (on ? 1 : -1));
  const activo = _busy > 0;
  document.body.classList.toggle("busy", activo);
  $("#progress")?.classList.toggle("on", activo);
}

// ---------- Carga de datos ----------
async function cargarTodo() {
  if (!sb) return;
  setBusy(true);
  try {
  const [casas, cajeras, partidos, movimientos, retiros, apuestas, lineas] = await Promise.all([
    sb.from("casas").select("*").order("nombre"),
    sb.from("cajeras").select("*").order("nombre"),
    sb.from("partidos").select("*").order("fecha", { ascending: false, nullsFirst: false }).order("creado_en", { ascending: false }),
    sb.from("movimientos").select("*").order("creado_en", { ascending: false }),
    sb.from("retiros_ganancia").select("*").order("creado_en", { ascending: false }),
    sb.from("apuestas").select("*").order("creado_en", { ascending: false }),
    sb.from("lineas").select("*").order("orden"),
  ]);
  for (const r of [casas, cajeras, partidos, movimientos, retiros, apuestas, lineas]) {
    if (r.error) { mostrarError(r.error.message); return; }
  }
  state.retirosGanancia = retiros.data;
  state.casas = casas.data;
  state.casasById = {};
  casas.data.forEach((x) => { state.casasById[x.id] = x; });
  state.cajeras = cajeras.data;
  state.partidos = partidos.data;
  state.movimientos = movimientos.data;
  state.partidosById = {};
  partidos.data.forEach((p) => { state.partidosById[p.id] = p; });

  const porApuesta = {};
  lineas.data.forEach((l) => { (porApuesta[l.apuesta_id] ||= []).push(l); });
  state.apuestas = apuestas.data.map((a) => ({
    ...a,
    lineas: porApuesta[a.id] || [],
    _partido: state.partidosById[a.partido_id] || null,
  }));
  } finally {
    setBusy(false);
  }
}

function mostrarError(msg) {
  $("#banner").innerHTML = `<div class="banner" style="border-color:var(--danger);background:#3a1414;color:#f8a9a4;">⚠️ ${esc(msg)}</div>`;
}

// Última actualización global (ms): el creado_en más reciente entre todos los
// registros que cambian (apuestas, movimientos, partidos, retiros). 0 si no hay datos.
function ultimaActualizacionGlobal() {
  let max = 0;
  const considerar = (fecha) => {
    const t = fecha ? Date.parse(fecha) : NaN;
    if (!isNaN(t) && t > max) max = t;
  };
  state.apuestas.forEach((a) => considerar(a.creado_en));
  state.movimientos.forEach((m) => considerar(m.creado_en));
  state.partidos.forEach((p) => considerar(p.creado_en));
  state.retirosGanancia.forEach((r) => considerar(r.creado_en));
  return max;
}

// Formatea un timestamp (ms) como "dd/mm/aaaa HH:MM"
function fechaHora(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function actualizarUltimaAct() {
  const el = $("#ultima-act");
  if (!el) return;
  const ms = ultimaActualizacionGlobal();
  el.innerHTML = ms ? `Última actualización: <b>${fechaHora(ms)}</b>` : "";
}

// ============================================================
//   RENDER PRINCIPAL
// ============================================================
function render() {
  // banner de config
  if (!CONFIGURADO) {
    $("#banner").innerHTML = `<div class="banner">⚙️ Falta conectar la base de datos. Abrí <b>config.js</b> y pegá tu URL y anon key de Supabase. Mirá <b>README.md</b> para los pasos.</div>`;
  }
  actualizarUltimaAct();
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === state.tab));
  const v = $("#view");
  if (state.tab === "reportes") { v.innerHTML = viewReportes(); bindReportes(); }
  else if (state.tab === "partidos") { v.innerHTML = viewPartidos(); bindPartidos(); }
  else if (state.tab === "cajeras") { v.innerHTML = viewCajeras(); bindCajeras(); }
  else if (state.tab === "config") { v.innerHTML = viewConfig(); bindConfig(); }
  // Re-dispara el fade del contenido (cambio de tab/página/datos)
  v.classList.remove("fade-in");
  void v.offsetWidth;
  v.classList.add("fade-in");
}

// ============================================================
//   VISTA: REPORTES (con filtros)
// ============================================================
function viewReportes() {
  const f = state.filtroRep;
  const periodos = [["todo", "Todo"], ["semana", "Última semana"], ["mes", "Último mes"], ["custom", "Personalizado"]];
  const optPeriodo = periodos.map(([v, t]) => `<option value="${v}" ${f.periodo === v ? "selected" : ""}>${t}</option>`).join("");
  const optCajera = state.cajeras.map((c) => `<option ${f.cajera === c.nombre ? "selected" : ""}>${esc(c.nombre)}</option>`).join("");
  const cust = f.periodo === "custom";

  return `
    <div class="card">
      <h2>Filtros</h2>
      <div class="row">
        <div class="field"><label>Período</label><select id="f-periodo">${optPeriodo}</select></div>
        <div class="field"><label>Desde</label><input type="date" id="f-desde" value="${esc(f.desde)}" ${cust ? "" : "disabled"} /></div>
        <div class="field"><label>Hasta</label><input type="date" id="f-hasta" value="${esc(f.hasta)}" ${cust ? "" : "disabled"} /></div>
        <div class="field"><label>Cajera</label><select id="f-cajera"><option value="">Todas</option>${optCajera}</select></div>
        <div class="field"><label>Ingresado mín</label><input type="number" step="any" id="f-min" value="${esc(f.montoMin)}" /></div>
        <div class="field"><label>Ingresado máx</label><input type="number" step="any" id="f-max" value="${esc(f.montoMax)}" /></div>
        <button class="btn-ghost" id="f-limpiar">Limpiar</button>
      </div>
    </div>
    <div id="rep-results"></div>
  `;
}

function renderReporteResultados() {
  const lista = apuestasFiltradas();
  const calc = lista.map((a) => ({ a, c: calcApuesta(a) }));
  const resueltas = calc.filter((x) => x.c.profit != null);

  const profitTotal = resueltas.reduce((s, x) => s + x.c.profit, 0);
  const transferencia = calc.filter((x) => x.c.estado === "Cobrado").reduce((s, x) => s + x.c.premio, 0);
  const ingresadoTotal = calc.reduce((s, x) => s + x.c.ingresado, 0);
  const pctProm = resueltas.length
    ? resueltas.reduce((s, x) => s + (x.c.pct || 0), 0) / resueltas.length : null;

  const porMes = {};
  resueltas.forEach((x) => {
    const fecha = apuestaFecha(x.a);
    const k = fecha ? fecha.slice(0, 7) : "sin fecha";
    (porMes[k] ||= { profit: 0, n: 0 });
    porMes[k].profit += x.c.profit + bonoEstimadoApuesta(x.a); // profit + bono estimado
    porMes[k].n++;
  });
  const porCajera = {};
  resueltas.forEach((x) => {
    const k = x.a.cajera || "—";
    (porCajera[k] ||= { profit: 0, n: 0 }); porCajera[k].profit += x.c.profit; porCajera[k].n++;
  });
  const porCasa = {};
  calc.forEach((x) => x.a.lineas.forEach((l) => {
    const k = l.casa || "—";
    (porCasa[k] ||= { cargado: 0, n: 0 }); porCasa[k].cargado += num(l.monto_cargado); porCasa[k].n++;
  }));

  const filaMes = Object.entries(porMes).sort((a, b) => b[0].localeCompare(a[0]))
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v.n}</td><td class="num ${v.profit >= 0 ? "pos" : "neg"}">${money(v.profit)}</td></tr>`).join("");
  const filaCajera = Object.entries(porCajera).sort((a, b) => b[1].profit - a[1].profit)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v.n}</td><td class="num ${v.profit >= 0 ? "pos" : "neg"}">${money(v.profit)}</td></tr>`).join("");
  const filaCasa = Object.entries(porCasa).sort((a, b) => b[1].cargado - a[1].cargado)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v.n}</td><td class="num">${money(v.cargado)}</td></tr>`).join("");

  // Saldo total de TODAS las cajeras (siempre, sin filtrar por el filtro de reportes)
  const saldoCajeras = state.cajeras.reduce((s, c) => s + resumenCajera(c).saldo, 0);
  // Total ingresado en apuestas pendientes (sin resolver), dentro de los filtros
  const pendientes = calc.filter((x) => x.c.estado === "Pendiente");
  const pendientesTotal = pendientes.reduce((s, x) => s + x.c.ingresado, 0);

  // Profit total = "profit + bono estimado" de las apuestas resueltas + ganancias manuales
  const bonoGanado = resueltas.reduce((s, x) => s + bonoEstimadoApuesta(x.a), 0);
  // Ganancias cargadas a mano (no mueven saldo; cuentan como profit). Respeta período + cajera.
  const f = state.filtroRep;
  const { desde, hasta } = rangoReporte();
  const cajById = {};
  state.cajeras.forEach((c) => { cajById[c.id] = c; });
  const gananciaManual = state.movimientos
    .filter((m) => m.tipo === "Ganancia")
    .filter((m) => {
      const fecha = (m.creado_en || "").slice(0, 10);
      if (desde && fecha < desde) return false;
      if (hasta && fecha > hasta) return false;
      if (f.cajera) { const c = cajById[m.cajera_id]; if (!c || c.nombre !== f.cajera) return false; }
      return true;
    })
    .reduce((s, m) => s + num(m.monto), 0);
  const profitConBono = profitTotal + bonoGanado + gananciaManual;
  // Retiros de ganancia (reparto): bajan el profit ACTUAL, no el histórico. Respeta período.
  const retirosTotal = state.retirosGanancia.filter((r) => {
    const fecha = (r.creado_en || "").slice(0, 10);
    if (desde && fecha < desde) return false;
    if (hasta && fecha > hasta) return false;
    return true;
  }).reduce((s, r) => s + num(r.monto), 0);
  const profitActual = profitConBono - retirosTotal;

  const sinDatos = lista.length === 0;
  $("#rep-results").innerHTML = `
    <div class="toolbar" style="margin-bottom:14px">
      <button class="btn-ghost btn-sm" id="retirar-ganancia">💸 Retirar ganancia</button>
      <button class="btn-ghost btn-sm" id="ver-retiros">📜 Retiros (${state.retirosGanancia.length})</button>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="label">Profit total actual</div><div class="value ${profitActual >= 0 ? "pos" : "neg"}">${money(profitActual)}</div></div>
      <div class="kpi"><div class="label">Profit total histórico</div><div class="value ${profitConBono >= 0 ? "pos" : "neg"}">${money(profitConBono)}</div></div>
      <div class="kpi"><div class="label">Transferencia recibido</div><div class="value pos">${money(transferencia)}</div></div>
      <div class="kpi"><div class="label">Total ingresado</div><div class="value">${money(ingresadoTotal)}</div></div>
      <div class="kpi"><div class="label">Total saldo cajeras actual</div><div class="value ${saldoCajeras >= 0 ? "pos" : "neg"}">${money(saldoCajeras)}</div></div>
      <div class="kpi"><div class="label">Total en apuestas pendientes</div><div class="value">${money(pendientesTotal)}<span class="muted" style="font-size:14px"> · ${pendientes.length}</span></div></div>
      <div class="kpi"><div class="label">Apuestas resueltas</div><div class="value">${resueltas.length}<span class="muted" style="font-size:14px"> / ${lista.length}</span></div></div>
      <div class="kpi"><div class="label">% promedio</div><div class="value">${pct(pctProm)}</div></div>
    </div>
    ${sinDatos ? `<div class="card"><p class="muted">No hay apuestas para los filtros elegidos.</p></div>` : `
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><h2>Profit por mes</h2><div class="tbl-wrap"><table>
        <thead><tr><th>Mes</th><th class="num">Apuestas</th><th class="num">Profit</th></tr></thead>
        <tbody>${filaMes || `<tr><td colspan="3" class="muted">Sin datos</td></tr>`}</tbody></table></div></div>
      <div class="card"><h2>Profit por cajera</h2><div class="tbl-wrap"><table>
        <thead><tr><th>Cajera</th><th class="num">Apuestas</th><th class="num">Profit</th></tr></thead>
        <tbody>${filaCajera || `<tr><td colspan="3" class="muted">Sin datos</td></tr>`}</tbody></table></div></div>
    </div>
    <div class="card"><h2>Dinero ingresado por casa</h2><div class="tbl-wrap"><table>
      <thead><tr><th>Casa</th><th class="num">Líneas</th><th class="num">Cargado</th></tr></thead>
      <tbody>${filaCasa || `<tr><td colspan="3" class="muted">Sin datos</td></tr>`}</tbody></table></div></div>`}
  `;

  // botones de retiro de ganancia (se recrean en cada render de resultados)
  $("#retirar-ganancia")?.addEventListener("click", () => abrirRetirarGanancia());
  $("#ver-retiros")?.addEventListener("click", () => abrirRetirosGanancia());
}

function bindReportes() {
  const f = state.filtroRep;
  const refrescar = () => renderReporteResultados();

  $("#f-periodo").addEventListener("change", (e) => {
    f.periodo = e.target.value;
    const cust = f.periodo === "custom";
    $("#f-desde").disabled = !cust;
    $("#f-hasta").disabled = !cust;
    refrescar();
  });
  $("#f-desde").addEventListener("change", (e) => { f.desde = e.target.value; refrescar(); });
  $("#f-hasta").addEventListener("change", (e) => { f.hasta = e.target.value; refrescar(); });
  $("#f-cajera").addEventListener("change", (e) => { f.cajera = e.target.value; refrescar(); });
  $("#f-min").addEventListener("input", (e) => { f.montoMin = e.target.value; refrescar(); });
  $("#f-max").addEventListener("input", (e) => { f.montoMax = e.target.value; refrescar(); });
  $("#f-limpiar").addEventListener("click", () => {
    state.filtroRep = { periodo: "todo", desde: "", hasta: "", cajera: "", montoMin: "", montoMax: "" };
    render();
  });

  renderReporteResultados();
}

// ----- Retiro de ganancia (reparto): baja el profit actual, no el histórico -----
function abrirRetirarGanancia() {
  if (!sb) { alert("Primero configurá Supabase en config.js"); return; }
  const dlg = document.createElement("dialog");
  dlg.innerHTML = `
    <form method="dialog" id="form-retiro-gan">
      <div class="modal-head">
        <h2 style="margin:0">💸 Retirar ganancia</h2>
        <button type="button" class="btn-ghost btn-sm" id="rg-cerrar">✕</button>
      </div>
      <div class="modal-body">
        <p class="muted" style="margin:0 0 10px">Baja el <b>Profit total actual</b> (reparto). El histórico no cambia. El reparto entre ustedes es interno, no se guarda.</p>
        <div><label>Monto a retirar</label><input type="number" step="any" name="monto" placeholder="1000000" required autofocus /></div>
        <div style="margin-top:12px"><label>Nota (opcional)</label><input name="nota" placeholder="Reparto con socio" /></div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn-ghost" id="rg-cancelar">Cancelar</button>
        <button type="submit" class="btn-primary">Retirar</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  const f = $("#form-retiro-gan", dlg);
  const cerrar = () => { dlg.close(); dlg.remove(); };
  $("#rg-cerrar", dlg).addEventListener("click", cerrar);
  $("#rg-cancelar", dlg).addEventListener("click", cerrar);
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const monto = num(f.monto.value);
    if (!(monto > 0)) { alert("Ingresá un monto mayor a 0."); return; }
    const { error } = await sb.from("retiros_ganancia").insert({ monto, nota: f.nota.value.trim() || null });
    if (error) { alert("Error: " + error.message); return; }
    await cargarTodo(); render(); cerrar();
  });
}

function abrirRetirosGanancia() {
  const rows = state.retirosGanancia.map((r) => `<tr>
    <td>${esc((r.creado_en || "").slice(0, 10))}</td>
    <td>${esc(r.nota || "—")}</td>
    <td class="num neg">-${money(num(r.monto))}</td>
    <td><button type="button" class="btn-danger btn-sm" data-del-retiro="${r.id}" title="Borrar">🗑️</button></td>
  </tr>`).join("");

  const dlg = document.createElement("dialog");
  dlg.innerHTML = `
    <form method="dialog" id="form-retiros">
      <div class="modal-head">
        <h2 style="margin:0">📜 Retiros de ganancia</h2>
        <button type="button" class="btn-ghost btn-sm" id="rt-cerrar">✕</button>
      </div>
      <div class="modal-body">
        <div class="tbl-wrap"><table>
          <thead><tr><th>Fecha</th><th>Nota</th><th class="num">Monto</th><th></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="4" class="muted">Sin retiros.</td></tr>`}</tbody>
        </table></div>
      </div>
      <div class="modal-foot">
        <button type="submit" class="btn-primary">Cerrar</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  const cerrar = () => { dlg.close(); dlg.remove(); };
  $("#rt-cerrar", dlg).addEventListener("click", cerrar);
  $("#form-retiros", dlg).addEventListener("submit", (e) => { e.preventDefault(); cerrar(); });
  $$("[data-del-retiro]", dlg).forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("¿Borrar este retiro? Vuelve a sumar al profit actual.")) return;
    const { error } = await sb.from("retiros_ganancia").delete().eq("id", b.dataset.delRetiro);
    if (error) { alert("Error: " + error.message); return; }
    await cargarTodo(); render(); cerrar(); abrirRetirosGanancia();
  }));
}

// ============================================================
//   VISTA: PARTIDOS (con apuestas anidadas)
// ============================================================
function viewPartidos() {
  // conteo por estado de partido para los chips
  const cont = { "": state.partidos.length, Pendiente: 0, Finalizado: 0 };
  state.partidos.forEach((p) => { cont[estadoPartido(p)]++; });

  const lista = ordenarPartidos(state.filtroEstado
    ? state.partidos.filter((p) => estadoPartido(p) === state.filtroEstado)
    : state.partidos);

  const total = lista.length;
  const paginas = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (state.pagina > paginas) state.pagina = paginas;
  if (state.pagina < 1) state.pagina = 1;
  const inicio = (state.pagina - 1) * PAGE_SIZE;
  const visibles = lista.slice(inicio, inicio + PAGE_SIZE);

  const chips = [["", "Todos"], ["Pendiente", "Pendientes"], ["Finalizado", "Finalizados"]]
    .map(([v, t]) => `<button class="chip-f ${state.filtroEstado === v ? "active" : ""}" data-estado="${v}">${t} <span class="chip-n">${cont[v] || 0}</span></button>`)
    .join("");

  const cards = visibles.map(cardPartido).join("");

  const desde = total ? inicio + 1 : 0;
  const hasta = Math.min(inicio + PAGE_SIZE, total);
  const pager = paginas > 1 ? `
    <div class="toolbar" style="justify-content:center; margin-top:14px; margin-bottom:0">
      <button class="btn-ghost btn-sm" id="prev" ${state.pagina <= 1 ? "disabled" : ""}>‹ Anterior</button>
      <span class="muted">Página ${state.pagina} de ${paginas}</span>
      <button class="btn-ghost btn-sm" id="next" ${state.pagina >= paginas ? "disabled" : ""}>Siguiente ›</button>
    </div>` : "";

  return `
    <div class="toolbar">
      <button class="btn-primary" id="nuevo-partido">+ Nuevo partido</button>
      <div class="spacer"></div>
      <span class="muted">${total ? `${desde}–${hasta} de ${total}` : "0"} partido(s)</span>
    </div>
    <div class="chips-filtro">${chips}</div>
    ${cards || `<div class="card"><p class="muted">Sin partidos todavía. Creá el primero con “+ Nuevo partido”.</p></div>`}
    ${pager}
  `;
}

// Fila de una apuesta dentro de la tarjeta de su partido
function filaApuesta(a) {
  const c = calcApuesta(a);
  const pend = c.estado === "Pendiente";
  const pot = pend ? potencialPorCasa(a) : [];
  const premioCell = pend ? potListHtml(pot, "premio") : money(c.premio);
  const profitCell = pend ? potListHtml(pot, "profit") : (c.profit == null ? "—" : money(c.profit));
  return `<tr>
    <td data-label="Cajera">${esc(a.cajera || "—")}</td>
    <td data-label="Estado"><span class="badge ${esc(c.estado)}">${esc(c.estado)}</span></td>
    <td data-label="Resultado / Cuota">${lineasApuestaHtml(a)}</td>
    <td class="num" data-label="Ingresado">${money(c.ingresado)}</td>
    <td class="num" data-label="${pend ? "Premio potencial" : "Premio"}">${premioCell}</td>
    <td class="num ${pend || c.profit == null ? "" : c.profit >= 0 ? "pos" : "neg"}" data-label="${pend ? "Profit potencial" : "Profit"}">${profitCell}</td>
    <td data-label="">
      <div class="acciones">
        <div class="acc-left">
          <button class="btn-danger btn-sm" data-del="${a.id}" title="Eliminar">🗑️</button>
          <button class="btn-ghost btn-sm" data-edit="${a.id}">✏️ Editar</button>
        </div>
        <div class="acc-right">
          <button class="btn-ghost btn-sm" data-detalle="${a.id}">👁️ Detalle</button>
        </div>
      </div>
    </td>
  </tr>`;
}

// Tarjeta de un partido con sus apuestas
function cardPartido(p) {
  const est = estadoPartido(p);
  const cp = calcPartido(p);
  const bonoEst = bonoEstimadoPartido(p);
  const abierto = !state.partidosColapsados.has(p.id);
  const filas = cp.aps.map(filaApuesta).join("");
  const fechaTxt = [p.fecha || "", p.hora ? fmtHora(p.hora) : ""].filter(Boolean).join(" · ");

  return `<div class="card partido">
    <div class="partido-head">
      <div class="partido-info">
        <button type="button" class="btn-ghost partido-toggle" data-toggle-partido="${p.id}" title="${abierto ? "Colapsar" : "Desplegar"}">${abierto ? "▾ Menos" : "▸ Más"}</button>
        <h2 style="margin:0">${esc(p.nombre)}</h2>
        ${fechaTxt ? `<span class="muted">${esc(fechaTxt)}</span>` : ""}
        <span class="badge ${est}">${est}</span>
        ${est === "Finalizado" && p.resultado_ganador ? `<span class="muted">· ganó <b>${esc(p.resultado_ganador)}</b></span>` : ""}
      </div>
      <div class="acciones">
        <div class="acc-left">
          <button class="btn-danger btn-sm" data-del-partido="${p.id}" title="Eliminar partido">🗑️</button>
          <button class="btn-ghost btn-sm" data-edit-partido="${p.id}">✏️ Editar</button>
        </div>
        <div class="acc-right">
          ${est === "Pendiente"
            ? `<button class="btn-primary btn-sm" data-resolver-partido="${p.id}" ${cp.n ? "" : "disabled"}>✅ Resolver</button>`
            : `<button class="btn-ghost btn-sm" data-resolver-partido="${p.id}">↩️ Cambiar resultado</button>`}
        </div>
      </div>
    </div>
    <div class="partido-meta">
      <span>${cp.n} apuesta(s)</span>
      <span>Ingresado: <b>${money(cp.ingresado)}</b></span>
      ${cp.profitDef ? `<span>Profit: <b class="${cp.profit >= 0 ? "pos" : "neg"}">${money(cp.profit)}</b></span>` : ""}
      ${bonoEst > 0 ? `<span>Bono estimado: <b class="pos">${money(bonoEst)}</b></span>` : ""}
      ${cp.profitDef && bonoEst > 0 ? `<span>Profit + bono (est.): <b class="pos">${money(cp.profit + bonoEst)}</b></span>` : ""}
    </div>
    ${abierto ? `
    ${balanceHtml(p, est)}
    <button class="btn-primary add-apuesta-btn" data-add-apuesta="${p.id}">+ Agregar apuesta</button>
    <div class="tbl-wrap">
      <table class="apuestas-tbl">
        <thead><tr>
          <th>Cajera</th><th>Estado</th><th>Resultado / Cuota</th><th class="num">Ingresado</th>
          <th class="num">Premio</th><th class="num">Profit</th><th></th>
        </tr></thead>
        <tbody>${filas || `<tr><td colspan="7" class="muted">Sin apuestas. Agregá la primera.</td></tr>`}</tbody>
      </table>
    </div>
    ` : ""}
  </div>`;
}

function bindPartidos() {
  $("#nuevo-partido")?.addEventListener("click", () => abrirModalPartido(null));
  $$("[data-edit-partido]").forEach((b) => b.addEventListener("click", () =>
    abrirModalPartido(state.partidosById[b.dataset.editPartido])));
  $$("[data-del-partido]").forEach((b) => b.addEventListener("click", () => borrarPartido(b.dataset.delPartido)));
  $$("[data-resolver-partido]").forEach((b) => b.addEventListener("click", () =>
    abrirResolverPartido(state.partidosById[b.dataset.resolverPartido])));
  $$("[data-toggle-partido]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.togglePartido;
    if (state.partidosColapsados.has(id)) state.partidosColapsados.delete(id);
    else state.partidosColapsados.add(id);
    render();
  }));
  $$("[data-add-apuesta]").forEach((b) => b.addEventListener("click", () => abrirModal(null, b.dataset.addApuesta)));

  $$("[data-edit]").forEach((b) => b.addEventListener("click", () =>
    abrirModal(state.apuestas.find((a) => a.id === b.dataset.edit))));
  $$("[data-detalle]").forEach((b) => b.addEventListener("click", () =>
    abrirDetalle(state.apuestas.find((a) => a.id === b.dataset.detalle))));
  $$("[data-del]").forEach((b) => b.addEventListener("click", () => borrarApuesta(b.dataset.del)));

  $("#prev")?.addEventListener("click", () => { state.pagina--; render(); });
  $("#next")?.addEventListener("click", () => { state.pagina++; render(); });
  $$("[data-estado]").forEach((b) => b.addEventListener("click", () => {
    state.filtroEstado = b.dataset.estado;
    state.pagina = 1; // al cambiar el filtro, volver a la primera página
    render();
  }));
}

// ============================================================
//   MODAL: Nuevo / Editar partido
// ============================================================
function abrirModalPartido(partido) {
  if (partido === undefined) return;
  const editando = !!partido;
  const p = partido || { nombre: "", fecha: "", hora: "" };

  const dlg = document.createElement("dialog");
  dlg.innerHTML = `
    <form method="dialog" id="form-partido">
      <div class="modal-head">
        <h2 style="margin:0">${editando ? "Editar" : "Nuevo"} partido</h2>
        <button type="button" class="btn-ghost btn-sm" id="p-cerrar">✕</button>
      </div>
      <div class="modal-body">
        <div class="grid grid-2">
          <div style="grid-column:1/-1"><label>Partido / Evento</label><input name="nombre" value="${esc(p.nombre)}" required placeholder="PSG vs Arsenal" /></div>
          <div><label>Fecha</label><input type="date" name="fecha" value="${esc(p.fecha || "")}" /></div>
          <div><label>Hora</label><input name="hora" value="${esc(p.hora || "")}" placeholder="13 hs" /></div>
        </div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn-ghost" id="p-cancelar">Cancelar</button>
        <button type="submit" class="btn-primary">${editando ? "Guardar cambios" : "Crear partido"}</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const cerrar = () => { dlg.close(); dlg.remove(); };
  $("#p-cerrar", dlg).addEventListener("click", cerrar);
  $("#p-cancelar", dlg).addEventListener("click", cerrar);
  $("#form-partido", dlg).addEventListener("submit", (e) => {
    e.preventDefault();
    guardarPartido(dlg, editando ? p.id : null).then((ok) => { if (ok) cerrar(); });
  });
}

// ============================================================
//   MODAL: Nueva / Editar apuesta (dentro de un partido)
// ============================================================
let modalLineas = []; // working copy mientras el modal está abierto

function casaPermiteGratis(nombre) {
  const c = state.casas.find((x) => x.nombre === nombre);
  return !!(c && c.permite_gratis);
}

function nuevaLinea(casa = "") {
  return { casa, cajera: "", monto_cargado: "", bono_pct: 0, cuota: "", resultado: "", apuesta_gratis: "" };
}

function abrirModal(apuesta, partidoId) {
  if (!apuesta) return abrirModalNueva(partidoId); // alta: una fila por cajera → varias apuestas
  const editando = true;
  const a = apuesta;
  const pid = editando ? a.partido_id : partidoId;
  const partido = state.partidosById[pid];
  // líneas: las existentes, o las casas por defecto
  modalLineas = editando
    ? a.lineas.map((l) => ({ ...l }))
    : (CFG.CASAS_POR_DEFECTO || ["Vira"]).map((n) => nuevaLinea(n));

  const dlg = document.createElement("dialog");
  dlg.innerHTML = `
    <form method="dialog" id="form-apuesta">
      <div class="modal-head">
        <h2 style="margin:0">${editando ? "Editar" : "Nueva"} apuesta${partido ? ` · ${esc(partido.nombre)}` : ""}</h2>
        <button type="button" class="btn-ghost btn-sm" id="cerrar">✕</button>
      </div>
      <div class="modal-body">
        <div class="grid grid-2">
          <div><label>Cajera</label>${selectCajera(a.cajera)}</div>
          <div><label>Premio cobrado (override, opcional)</label><input type="number" step="any" name="premio_cobrado" value="${a.premio_cobrado ?? ""}" placeholder="auto desde la cuota" /></div>
        </div>

        <h2 style="margin:18px 0 8px">Casas</h2>
        <div id="lineas"></div>
        <button type="button" class="btn-ghost btn-sm" id="add-linea">+ Agregar casa</button>

        <div style="margin-top:12px"><label>Notas</label><textarea name="notas" rows="2">${esc(a.notas || "")}</textarea></div>
        <div id="resumen" class="muted" style="margin-top:12px"></div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn-ghost" id="cancelar">Cancelar</button>
        <button type="submit" class="btn-primary">${editando ? "Guardar cambios" : "Crear apuesta"}</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const cerrar = () => { dlg.close(); dlg.remove(); };
  $("#cerrar", dlg).addEventListener("click", cerrar);
  $("#cancelar", dlg).addEventListener("click", cerrar);
  $("#add-linea", dlg).addEventListener("click", () => { modalLineas.push(nuevaLinea()); renderLineas(dlg); });
  $("[name=premio_cobrado]", dlg).addEventListener("input", () => actualizarResumen(dlg));

  renderLineas(dlg);

  $("#form-apuesta", dlg).addEventListener("submit", (e) => {
    e.preventDefault();
    guardarApuesta(dlg, editando ? a.id : null, pid).then((ok) => { if (ok) { cerrar(); } });
  });
}

function selectCajera(sel) {
  const opts = state.cajeras.map((c) => `<option ${c.nombre === sel ? "selected" : ""}>${esc(c.nombre)}</option>`).join("");
  return `<select name="cajera"><option value="">— elegir —</option>${opts}</select>`;
}

// ----- Alta de apuestas: una fila por cajera → se crea una apuesta por cajera -----
function abrirModalNueva(partidoId) {
  const partido = state.partidosById[partidoId];
  modalLineas = (CFG.CASAS_POR_DEFECTO || ["Vira"]).map((n) => nuevaLinea(n));

  const dlg = document.createElement("dialog");
  dlg.innerHTML = `
    <form method="dialog" id="form-apuesta">
      <div class="modal-head">
        <h2 style="margin:0">Nueva apuesta${partido ? ` · ${esc(partido.nombre)}` : ""}</h2>
        <button type="button" class="btn-ghost btn-sm" id="cerrar">✕</button>
      </div>
      <div class="modal-body">
        <p class="muted" style="margin:0 0 8px">Cada fila lleva su cajera. Se crea <b>una apuesta por cajera</b> (las filas de la misma cajera se agrupan).</p>
        <div id="lineas"></div>
        <button type="button" class="btn-ghost btn-sm" id="add-linea">+ Agregar casa</button>
        <div style="margin-top:12px"><label>Notas</label><textarea name="notas" rows="2"></textarea></div>
        <div id="resumen" class="muted" style="margin-top:12px"></div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn-ghost" id="cancelar">Cancelar</button>
        <button type="submit" class="btn-primary">Crear apuesta(s)</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const cerrar = () => { dlg.close(); dlg.remove(); };
  $("#cerrar", dlg).addEventListener("click", cerrar);
  $("#cancelar", dlg).addEventListener("click", cerrar);
  $("#add-linea", dlg).addEventListener("click", () => { modalLineas.push(nuevaLinea()); renderLineasNueva(dlg); });

  renderLineasNueva(dlg);

  $("#form-apuesta", dlg).addEventListener("submit", (e) => {
    e.preventDefault();
    guardarApuestasMultiples(dlg, partidoId).then((ok) => { if (ok) cerrar(); });
  });
}

function renderLineasNueva(dlg) {
  const cont = $("#lineas", dlg);
  cont.innerHTML = modalLineas.map((l, i) => {
    const c = calcLinea(l);
    const cajeraOpts = state.cajeras.map((x) => `<option ${x.nombre === l.cajera ? "selected" : ""}>${esc(x.nombre)}</option>`).join("");
    const casaOpts = state.casas.map((x) => `<option ${x.nombre === l.casa ? "selected" : ""}>${esc(x.nombre)}</option>`).join("");
    const gratisField = casaPermiteGratis(l.casa)
      ? `<div><label>🎁 Apuesta gratis</label><input type="number" step="any" data-f="apuesta_gratis" value="${l.apuesta_gratis ?? ""}" placeholder="0" /></div>`
      : "";
    return `<div class="linea" data-i="${i}">
      <div><label>Cajera</label><select data-f="cajera"><option value="">— elegir —</option>${cajeraOpts}</select></div>
      <div><label>Casa</label><select data-f="casa"><option value="">—</option>${casaOpts}</select></div>
      <div><label>Cargado (real)</label><input type="number" step="any" data-f="monto_cargado" value="${l.monto_cargado}" /></div>
      ${gratisField}
      <div><label>Cuota</label><input type="number" step="any" data-f="cuota" value="${l.cuota}" /></div>
      <div><label>Resultado</label><input data-f="resultado" value="${esc(l.resultado || "")}" placeholder="PSG / Empate" /></div>
      <div class="calc"><span class="calc-txt">apostado<b>${money(c.apostado)}</b>premio ${money(c.premio)}</span>
        <button type="button" class="btn-danger btn-sm" data-rm="${i}" style="margin-top:4px">✕</button></div>
    </div>`;
  }).join("");

  $$(".linea [data-f]", cont).forEach((inp) => {
    inp.addEventListener("input", () => {
      const row = inp.closest(".linea");
      const i = +row.dataset.i;
      const f = inp.dataset.f;
      modalLineas[i][f] = inp.value;
      if (f === "casa") {
        if (!casaPermiteGratis(inp.value)) modalLineas[i].apuesta_gratis = "";
        renderLineasNueva(dlg);
        actualizarResumenNueva(dlg);
        return;
      }
      const c = calcLinea(modalLineas[i]);
      const txt = $(".calc-txt", row);
      if (txt) txt.innerHTML = `apostado<b>${money(c.apostado)}</b>premio ${money(c.premio)}`;
      actualizarResumenNueva(dlg);
    });
  });
  $$("[data-rm]", cont).forEach((b) => b.addEventListener("click", () => {
    modalLineas.splice(+b.dataset.rm, 1);
    renderLineasNueva(dlg);
  }));
  actualizarResumenNueva(dlg);
}

function actualizarResumenNueva(dlg) {
  const totalIng = modalLineas.reduce((s, l) => s + num(l.monto_cargado), 0);
  const cajeras = [...new Set(modalLineas.map((l) => l.cajera).filter(Boolean))];
  $("#resumen", dlg).innerHTML =
    `Se crearán <b>${cajeras.length}</b> apuesta(s) (una por cajera) · Total ingresado: <b>${money(totalIng)}</b>`;
}

async function guardarApuestasMultiples(dlg, partidoId) {
  if (!sb) { alert("Primero configurá Supabase en config.js"); return false; }
  const f = $("#form-apuesta", dlg);
  const notas = f.notas.value.trim() || null;

  const validas = modalLineas.filter((l) => l.casa || num(l.monto_cargado) > 0 || num(l.apuesta_gratis) > 0);
  if (!validas.length) { alert("Agregá al menos una casa con datos."); return false; }
  if (validas.some((l) => !l.cajera)) { alert("Cada fila necesita una cajera."); return false; }

  // agrupar por cajera
  const grupos = {};
  validas.forEach((l) => { (grupos[l.cajera] ||= []).push(l); });

  for (const [cajera, lineas] of Object.entries(grupos)) {
    const { data, error } = await sb.from("apuestas")
      .insert({ partido_id: partidoId, cajera, premio_cobrado: null, notas })
      .select("id").single();
    if (error) { alert("Error: " + error.message); return false; }
    const lineasPayload = lineas.map((l, i) => ({
      apuesta_id: data.id,
      casa: l.casa || "",
      monto_cargado: num(l.monto_cargado),
      bono_pct: 0,
      cuota: l.cuota === "" ? null : num(l.cuota),
      resultado: (l.resultado || "").trim() || null,
      apuesta_gratis: num(l.apuesta_gratis),
      orden: i,
    }));
    const { error: e2 } = await sb.from("lineas").insert(lineasPayload);
    if (e2) { alert("Error guardando líneas: " + e2.message); return false; }
  }

  await cargarTodo();
  render();
  return true;
}

function renderLineas(dlg) {
  const cont = $("#lineas", dlg);
  cont.innerHTML = modalLineas.map((l, i) => {
    const c = calcLinea(l);
    const casaOpts = state.casas.map((x) => `<option ${x.nombre === l.casa ? "selected" : ""}>${esc(x.nombre)}</option>`).join("");
    const gratisField = casaPermiteGratis(l.casa)
      ? `<div><label>🎁 Apuesta gratis</label><input type="number" step="any" data-f="apuesta_gratis" value="${l.apuesta_gratis ?? ""}" placeholder="0" /></div>`
      : "";
    return `<div class="linea" data-i="${i}">
      <div><label>Casa</label><select data-f="casa"><option value="">—</option>${casaOpts}</select></div>
      <div><label>Cargado (real)</label><input type="number" step="any" data-f="monto_cargado" value="${l.monto_cargado}" /></div>
      ${gratisField}
      <div><label>Cuota</label><input type="number" step="any" data-f="cuota" value="${l.cuota}" /></div>
      <div><label>Resultado</label><input data-f="resultado" value="${esc(l.resultado || "")}" placeholder="PSG / Empate" /></div>
      <div class="calc"><span class="calc-txt">apostado<b>${money(c.apostado)}</b>premio ${money(c.premio)}</span>
        <button type="button" class="btn-danger btn-sm" data-rm="${i}" style="margin-top:4px">✕</button></div>
    </div>`;
  }).join("");

  $$(".linea [data-f]", cont).forEach((inp) => {
    inp.addEventListener("input", () => {
      const row = inp.closest(".linea");
      const i = +row.dataset.i;
      const f = inp.dataset.f;
      modalLineas[i][f] = inp.value;
      if (f === "casa") {
        // al cambiar la casa: re-render (para mostrar/ocultar "Apuesta gratis")
        if (!casaPermiteGratis(inp.value)) modalLineas[i].apuesta_gratis = "";
        renderLineas(dlg);
        actualizarResumen(dlg);
        return;
      }
      // actualizar solo el texto del cálculo de esta línea (no re-render → no se pierde el foco)
      const c = calcLinea(modalLineas[i]);
      const txt = $(".calc-txt", row);
      if (txt) txt.innerHTML = `apostado<b>${money(c.apostado)}</b>premio ${money(c.premio)}`;
      actualizarResumen(dlg);
    });
  });
  // botones de borrar línea (se rebindea entero en cada render completo)
  $$("[data-rm]", cont).forEach((b) => b.addEventListener("click", () => {
    modalLineas.splice(+b.dataset.rm, 1);
    renderLineas(dlg);
  }));
  actualizarResumen(dlg);
}

function actualizarResumen(dlg) {
  const fake = {
    premio_cobrado: $("[name=premio_cobrado]", dlg)?.value || "",
    lineas: modalLineas,
    _partido: null,
  };
  const c = calcApuesta(fake);
  const totalGratis = modalLineas.reduce((s, l) => s + num(l.apuesta_gratis), 0);
  const maxPremio = modalLineas.reduce((m, l) => Math.max(m, calcLinea(l).premio), 0);
  $("#resumen", dlg).innerHTML =
    `Ingresado: <b>${money(c.ingresado)}</b>` +
    (totalGratis > 0 ? ` · 🎁 Apuesta gratis: <b>${money(totalGratis)}</b>` : "") +
    ` · Premio potencial máx: <b>${money(maxPremio)}</b>`;
}

// ============================================================
//   PERSISTENCIA
// ============================================================
async function guardarPartido(dlg, id) {
  if (!sb) { alert("Primero configurá Supabase en config.js"); return false; }
  const f = $("#form-partido", dlg);
  const payload = {
    nombre: f.nombre.value.trim(),
    fecha: f.fecha.value || null,
    hora: f.hora.value.trim() || null,
  };
  let res;
  if (id) res = await sb.from("partidos").update(payload).eq("id", id);
  else res = await sb.from("partidos").insert(payload);
  if (res.error) { alert("Error: " + res.error.message); return false; }
  await cargarTodo();
  render();
  return true;
}

async function borrarPartido(id) {
  const n = apuestasDePartido(id).length;
  if (!confirm(n ? `¿Borrar este partido y sus ${n} apuesta(s)?` : "¿Borrar este partido?")) return;
  const { error } = await sb.from("partidos").delete().eq("id", id);
  if (error) { alert("Error: " + error.message); return; }
  await cargarTodo();
  render();
}

async function guardarApuesta(dlg, id, partidoId) {
  if (!sb) { alert("Primero configurá Supabase en config.js"); return false; }
  const f = $("#form-apuesta", dlg);
  const payload = {
    partido_id: partidoId,
    cajera: f.cajera.value || null,
    premio_cobrado: f.premio_cobrado.value === "" ? null : num(f.premio_cobrado.value),
    notas: f.notas.value.trim() || null,
  };

  let apuestaId = id;
  if (id) {
    const { error } = await sb.from("apuestas").update(payload).eq("id", id);
    if (error) { alert("Error: " + error.message); return false; }
    await sb.from("lineas").delete().eq("apuesta_id", id);
  } else {
    const { data, error } = await sb.from("apuestas").insert(payload).select("id").single();
    if (error) { alert("Error: " + error.message); return false; }
    apuestaId = data.id;
  }

  const lineasPayload = modalLineas
    .filter((l) => l.casa || num(l.monto_cargado) > 0 || num(l.apuesta_gratis) > 0)
    .map((l, i) => ({
      apuesta_id: apuestaId,
      casa: l.casa || "",
      monto_cargado: num(l.monto_cargado),
      bono_pct: 0,
      cuota: l.cuota === "" ? null : num(l.cuota),
      resultado: (l.resultado || "").trim() || null,
      apuesta_gratis: num(l.apuesta_gratis),
      orden: i,
    }));
  if (lineasPayload.length) {
    const { error } = await sb.from("lineas").insert(lineasPayload);
    if (error) { alert("Error guardando líneas: " + error.message); return false; }
  }

  await cargarTodo();
  render();
  return true;
}

async function borrarApuesta(id) {
  if (!confirm("¿Borrar esta apuesta?")) return;
  const { error } = await sb.from("apuestas").delete().eq("id", id);
  if (error) { alert("Error: " + error.message); return; }
  await cargarTodo();
  render();
}

// ============================================================
//   POPUP: Ver detalle de apuesta (solo lectura)
// ============================================================
function abrirDetalle(a) {
  if (!a) return;
  const c = calcApuesta(a);
  const p = a._partido;
  const lineasRows = (a.lineas || []).map((l) => {
    const lc = calcLinea(l);
    return `<tr>
      <td>${esc(l.casa || "—")}</td>
      <td class="num">${money(num(l.monto_cargado))}</td>
      <td class="num">${num(l.apuesta_gratis) > 0 ? money(num(l.apuesta_gratis)) : "—"}</td>
      <td class="num">${l.cuota == null || l.cuota === "" ? "—" : num(l.cuota)}</td>
      <td>${esc(l.resultado || "—")}</td>
      <td class="num">${money(lc.premio)}</td>
    </tr>`;
  }).join("");

  const dlg = document.createElement("dialog");
  dlg.innerHTML = `
    <form method="dialog" id="form-detalle">
      <div class="modal-head">
        <h2 style="margin:0">${esc(p ? p.nombre : "Apuesta")} <span class="badge ${esc(c.estado)}" style="margin-left:8px">${esc(c.estado)}</span></h2>
        <button type="button" class="btn-ghost btn-sm" id="d-cerrar">✕</button>
      </div>
      <div class="modal-body">
        <div class="detalle-grid">
          <div><label>Fecha</label><div class="ro">${esc((p && p.fecha) || "—")}</div></div>
          <div><label>Hora</label><div class="ro">${p && p.hora ? esc(fmtHora(p.hora)) : "—"}</div></div>
          <div><label>Cajera</label><div class="ro">${esc(a.cajera || "—")}</div></div>
          <div><label>Resultado ganador</label><div class="ro">${esc((p && p.resultado_ganador) || "—")}</div></div>
        </div>
        ${a.notas ? `<div style="margin-top:12px"><label>Notas</label><div class="ro">${esc(a.notas)}</div></div>` : ""}

        <h2 style="margin:18px 0 8px">Casas</h2>
        <div class="tbl-wrap"><table>
          <thead><tr>
            <th>Casa</th><th class="num">Cargado</th><th class="num">🎁 Gratis</th>
            <th class="num">Cuota</th><th>Resultado</th><th class="num">Premio</th>
          </tr></thead>
          <tbody>${lineasRows || `<tr><td colspan="6" class="muted">Sin casas</td></tr>`}</tbody>
        </table></div>

        <div class="kpis" style="margin-top:16px">
          <div class="kpi"><div class="label">Ingresado</div><div class="value" style="font-size:18px">${money(c.ingresado)}</div></div>
          <div class="kpi"><div class="label">Premio</div><div class="value" style="font-size:18px">${c.estado === "Pendiente" ? "—" : money(c.premio)}</div></div>
          <div class="kpi"><div class="label">Profit</div><div class="value ${c.profit == null ? "" : c.profit >= 0 ? "pos" : "neg"}" style="font-size:18px">${c.profit == null ? "—" : money(c.profit)}</div></div>
          <div class="kpi"><div class="label">%</div><div class="value ${c.pct == null ? "" : c.pct >= 0 ? "pos" : "neg"}" style="font-size:18px">${pct(c.pct)}</div></div>
        </div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn-ghost" id="d-editar">Editar</button>
        <button type="submit" class="btn-primary">Cerrar</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const cerrar = () => { dlg.close(); dlg.remove(); };
  $("#d-cerrar", dlg).addEventListener("click", cerrar);
  $("#d-editar", dlg).addEventListener("click", () => { cerrar(); abrirModal(a); });
  $("#form-detalle", dlg).addEventListener("submit", (e) => { e.preventDefault(); cerrar(); });
}

// ============================================================
//   POPUP: Resolver partido (carga el resultado real una vez)
// ============================================================
function abrirResolverPartido(p) {
  if (!p) return;
  const aps = apuestasDePartido(p.id);
  // unión de todos los resultados cubiertos por las líneas de todas las apuestas
  const resultados = [...new Set(
    aps.flatMap((a) => (a.lineas || []).map((l) => (l.resultado || "").trim())).filter(Boolean)
  )];

  const dlg = document.createElement("dialog");
  dlg.innerHTML = `
    <form method="dialog" id="form-resolver">
      <div class="modal-head">
        <h2 style="margin:0">Resolver — ${esc(p.nombre)}</h2>
        <button type="button" class="btn-ghost btn-sm" id="r-cerrar">✕</button>
      </div>
      <div class="modal-body">
        <div><label>Resultado ganador (resultado real del partido)</label>
          <select name="resultado_ganador">
            <option value="">— Pendiente (sin resolver) —</option>
            ${resultados.map((r) => `<option ${p.resultado_ganador === r ? "selected" : ""}>${esc(r)}</option>`).join("")}
          </select>
        </div>
        <p class="muted" style="margin:10px 0 0">Cada apuesta se resuelve sola según este resultado.</p>
        <div id="r-preview" style="margin-top:14px"></div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn-ghost" id="r-cancelar">Cancelar</button>
        <button type="submit" class="btn-primary">Guardar</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const f = $("#form-resolver", dlg);
  const cerrar = () => { dlg.close(); dlg.remove(); };
  $("#r-cerrar", dlg).addEventListener("click", cerrar);
  $("#r-cancelar", dlg).addEventListener("click", cerrar);

  const preview = () => {
    const res = f.resultado_ganador.value || null;
    const rows = aps.map((a) => {
      const c = calcApuesta({ ...a, _partido: { resultado_ganador: res } });
      return `<tr>
        <td>${esc(a.cajera || "—")}</td>
        <td><span class="badge ${esc(c.estado)}">${esc(c.estado)}</span></td>
        <td class="num">${money(c.ingresado)}</td>
        <td class="num">${res ? money(c.premio) : "—"}</td>
        <td class="num ${c.profit == null ? "" : c.profit >= 0 ? "pos" : "neg"}">${c.profit == null ? "—" : money(c.profit)}</td>
      </tr>`;
    }).join("");
    $("#r-preview", dlg).innerHTML = `<div class="tbl-wrap"><table>
      <thead><tr><th>Cajera</th><th>Estado</th><th class="num">Ingresado</th><th class="num">Premio</th><th class="num">Profit</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="muted">Sin apuestas</td></tr>`}</tbody></table></div>`;
  };

  f.resultado_ganador.addEventListener("change", preview);
  preview();

  f.addEventListener("submit", (e) => {
    e.preventDefault();
    resolverPartido(dlg, p.id).then((ok) => { if (ok) cerrar(); });
  });
}

async function resolverPartido(dlg, id) {
  if (!sb) { alert("Primero configurá Supabase en config.js"); return false; }
  const f = $("#form-resolver", dlg);
  const { error } = await sb.from("partidos")
    .update({ resultado_ganador: f.resultado_ganador.value || null })
    .eq("id", id);
  if (error) { alert("Error: " + error.message); return false; }
  await cargarTodo();
  render();
  return true;
}

// ============================================================
//   VISTA: CAJERAS (saldo / billetera)
// ============================================================
function viewCajeras() {
  if (!state.cajeras.length) {
    return `<div class="card"><p class="muted">No hay cajeras todavía. Agregá una en la pestaña <b>Configuración</b>.</p></div>`;
  }

  // Orden: las cajeras con actividad más reciente (carga/apuesta) primero;
  // las que no tuvieron nada recientemente quedan al final.
  const ordenadas = [...state.cajeras].sort((a, b) => ultimaActividadCajera(b) - ultimaActividadCajera(a));

  const cards = ordenadas.map((c) => {
    const r = resumenCajera(c);
    const casa = casaDeCajera(c);
    const pend = partidosPendientesCajera(c);
    const apostadoPend = pend.reduce((s, x) => s + x.monto, 0);
    return `<div class="card cajera">
      <div class="cajera-head">
        <h2 style="margin:0">${esc(c.nombre)}${casa ? ` <span class="muted" style="font-size:13px;font-weight:400">· ${esc(casa.nombre)}</span>` : ""}</h2>
        <div class="acc-right">
          <button class="btn-primary btn-sm" data-cargar="${c.id}">💵 Cargar</button>
          <button class="btn-ghost btn-sm" data-retirar="${c.id}">🏧 Retirar</button>
          <button class="btn-ghost btn-sm" data-ganancia="${c.id}">💰 Ganancia</button>
          <button class="btn-ghost btn-sm" data-movs="${c.id}">📜 Movimientos</button>
        </div>
      </div>
      <div class="cajera-saldo">
        <span class="label">Saldo disponible</span>
        <span class="value ${r.saldo >= 0 ? "pos" : "neg"}">${money(r.saldo)}</span>
      </div>
      <div class="cajera-desglose">
        <span>Apostado (pendiente) <b>${money(apostadoPend)}</b></span>
      </div>
      <div class="cajera-pendientes">
        <span class="label">Partidos pendientes</span>
        ${pend.length
          ? pend.map((x) => `<div class="pend-item">
              <span class="pend-nombre">${esc(x.partido.nombre)}${x.partido.fecha ? ` <span class="muted">· ${esc(x.partido.fecha)}</span>` : ""}</span>
              <b>${money(x.monto)}</b>
            </div>`).join("")
          : `<span class="muted" style="font-size:13px">Sin apuestas pendientes</span>`}
      </div>
    </div>`;
  }).join("");

  return `<div class="toolbar">
      <button class="btn-primary" id="cargar-saldo">💵 Cargar saldo</button>
      <button class="btn-ghost" id="retirar-saldo">🏧 Retirar</button>
      <button class="btn-ghost" id="ganancia-manual">💰 Ganancia</button>
      <div class="spacer"></div>
      <span class="muted">${state.cajeras.length} cajera(s)</span>
    </div>${cards}`;
}

function bindCajeras() {
  const byId = (id) => state.cajeras.find((c) => c.id === id);
  $("#cargar-saldo")?.addEventListener("click", () => abrirCargar(null));
  $("#retirar-saldo")?.addEventListener("click", () => abrirRetirar(null));
  $("#ganancia-manual")?.addEventListener("click", () => abrirGanancia(null));
  $$("[data-ganancia]").forEach((b) => b.addEventListener("click", () => abrirGanancia(byId(b.dataset.ganancia))));
  $$("[data-cargar]").forEach((b) => b.addEventListener("click", () => abrirCargar(byId(b.dataset.cargar))));
  $$("[data-retirar]").forEach((b) => b.addEventListener("click", () => abrirRetirar(byId(b.dataset.retirar))));
  $$("[data-movs]").forEach((b) => b.addEventListener("click", () => abrirMovimientos(byId(b.dataset.movs))));
}

// cajeraFija opcional: si no se pasa, el popup muestra un selector de cajera
function abrirCargar(cajeraFija) {
  if (!state.cajeras.length) { alert("No hay cajeras. Agregá una en Configuración."); return; }
  const seleccionable = !cajeraFija;
  const cajeraOpts = state.cajeras
    .map((x) => `<option value="${x.id}">${esc(x.nombre)}</option>`).join("");

  const dlg = document.createElement("dialog");
  dlg.innerHTML = `
    <form method="dialog" id="form-cargar">
      <div class="modal-head">
        <h2 style="margin:0">💵 Cargar saldo</h2>
        <button type="button" class="btn-ghost btn-sm" id="c-cerrar">✕</button>
      </div>
      <div class="modal-body">
        <div class="grid grid-2">
          <div><label>Cajera</label>${seleccionable
            ? `<select name="cajera_id">${cajeraOpts}</select>`
            : `<input value="${esc(cajeraFija.nombre)}" disabled />`}</div>
          <div><label>Monto a cargar</label><input type="number" step="any" name="monto" placeholder="100000" required autofocus /></div>
          <div><label>Bono %</label><input type="number" step="any" name="bono" /></div>
          <label style="display:flex;align-items:flex-end;gap:6px;color:var(--text);cursor:pointer;padding-bottom:8px">
            <input type="checkbox" name="con_bono" checked style="width:auto" /> Cargar con bono
          </label>
        </div>
        <p class="muted" id="c-casino" style="margin:6px 0 0"></p>
        <div style="margin-top:12px"><label>Nota (opcional)</label><input name="nota" placeholder="Depósito" /></div>
        <div id="c-resumen" class="muted" style="margin-top:12px"></div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn-ghost" id="c-cancelar">Cancelar</button>
        <button type="submit" class="btn-primary">Cargar</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const f = $("#form-cargar", dlg);
  const cerrar = () => { dlg.close(); dlg.remove(); };
  $("#c-cerrar", dlg).addEventListener("click", cerrar);
  $("#c-cancelar", dlg).addEventListener("click", cerrar);

  const cajeraActual = () => seleccionable
    ? state.cajeras.find((x) => x.id === f.cajera_id.value)
    : cajeraFija;

  // al cambiar de cajera (o togglear bono): actualizar casino, bono y preview
  const onCajera = () => {
    const c = cajeraActual();
    const casa = casaDeCajera(c);
    const bonoCasa = casa ? num(casa.bono_pct) : 0;
    $("#c-casino", dlg).innerHTML = `Casino: <b>${casa ? `${esc(casa.nombre)} · bono ${bonoCasa}%` : "sin casino asociado"}</b>`;
    if (f.con_bono.checked) f.bono.value = bonoCasa;
    refrescar();
  };
  const refrescar = () => {
    const c = cajeraActual();
    const saldoActual = c ? resumenCajera(c).saldo : 0;
    const conBono = f.con_bono.checked;
    f.bono.disabled = !conBono;
    const bono = conBono ? num(f.bono.value) : 0;
    const acreditado = num(f.monto.value) * (1 + bono / 100);
    $("#c-resumen", dlg).innerHTML =
      `Se acredita: <b>${money(acreditado)}</b>${conBono && bono > 0 ? ` (incluye bono ${bono}%)` : ""} · Saldo resultante: <b>${money(saldoActual + acreditado)}</b>`;
  };

  if (seleccionable) f.cajera_id.addEventListener("change", onCajera);
  f.monto.addEventListener("input", refrescar);
  f.bono.addEventListener("input", refrescar);
  f.con_bono.addEventListener("change", onCajera);
  onCajera();

  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const c = cajeraActual();
    if (!c) { alert("Elegí una cajera."); return; }
    const casa = casaDeCajera(c);
    const payload = {
      cajera_id: c.id,
      tipo: "Carga",
      monto: num(f.monto.value),
      bono_pct: f.con_bono.checked ? num(f.bono.value) : 0,
      casa: casa ? casa.nombre : null,
      nota: f.nota.value.trim() || null,
    };
    if (guardarMovimiento(payload)) cerrar();
  });
}

// cajeraFija opcional: si no se pasa, el popup muestra un selector de cajera
function abrirRetirar(cajeraFija) {
  if (!state.cajeras.length) { alert("No hay cajeras. Agregá una en Configuración."); return; }
  const seleccionable = !cajeraFija;
  const cajeraOpts = state.cajeras
    .map((x) => `<option value="${x.id}">${esc(x.nombre)}</option>`).join("");

  const dlg = document.createElement("dialog");
  dlg.innerHTML = `
    <form method="dialog" id="form-retirar">
      <div class="modal-head">
        <h2 style="margin:0">🏧 Retirar saldo</h2>
        <button type="button" class="btn-ghost btn-sm" id="r-cerrar">✕</button>
      </div>
      <div class="modal-body">
        <div class="grid grid-2">
          <div><label>Cajera</label>${seleccionable
            ? `<select name="cajera_id">${cajeraOpts}</select>`
            : `<input value="${esc(cajeraFija.nombre)}" disabled />`}</div>
          <div><label>Monto a retirar</label><input type="number" step="any" name="monto" placeholder="50000" required autofocus /></div>
        </div>
        <p class="muted" id="r-saldo" style="margin:8px 0 0"></p>
        <div style="margin-top:12px"><label>Nota (opcional)</label><input name="nota" placeholder="Retiro" /></div>
        <div id="r-resumen" class="muted" style="margin-top:12px"></div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn-ghost" id="r-cancelar">Cancelar</button>
        <button type="submit" class="btn-primary">Retirar</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const f = $("#form-retirar", dlg);
  const cerrar = () => { dlg.close(); dlg.remove(); };
  $("#r-cerrar", dlg).addEventListener("click", cerrar);
  $("#r-cancelar", dlg).addEventListener("click", cerrar);

  const cajeraActual = () => seleccionable
    ? state.cajeras.find((x) => x.id === f.cajera_id.value)
    : cajeraFija;

  const refrescar = () => {
    const c = cajeraActual();
    const saldoActual = c ? resumenCajera(c).saldo : 0;
    $("#r-saldo", dlg).innerHTML = `Saldo disponible: <b class="${saldoActual >= 0 ? "pos" : "neg"}">${money(saldoActual)}</b>`;
    const restante = saldoActual - num(f.monto.value);
    $("#r-resumen", dlg).innerHTML =
      `Saldo resultante: <b class="${restante >= 0 ? "pos" : "neg"}">${money(restante)}</b>` +
      (restante < 0 ? ` ⚠️ queda negativo` : "");
  };
  if (seleccionable) f.cajera_id.addEventListener("change", refrescar);
  f.monto.addEventListener("input", refrescar);
  refrescar();

  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const c = cajeraActual();
    if (!c) { alert("Elegí una cajera."); return; }
    const monto = num(f.monto.value);
    const saldoActual = resumenCajera(c).saldo;
    if (monto > saldoActual && !confirm("El retiro supera el saldo disponible y lo deja negativo. ¿Continuar?")) return;
    const payload = { cajera_id: c.id, tipo: "Retiro", monto, bono_pct: 0, casa: null, nota: f.nota.value.trim() || null };
    if (guardarMovimiento(payload)) cerrar();
  });
}

// Ganancia manual: cuenta como profit en el reporte, NO mueve el saldo.
function abrirGanancia(cajeraFija) {
  if (!state.cajeras.length) { alert("No hay cajeras. Agregá una en Configuración."); return; }
  const seleccionable = !cajeraFija;
  const cajeraOpts = state.cajeras
    .map((x) => `<option value="${x.id}">${esc(x.nombre)}</option>`).join("");

  const dlg = document.createElement("dialog");
  dlg.innerHTML = `
    <form method="dialog" id="form-ganancia">
      <div class="modal-head">
        <h2 style="margin:0">💰 Cargar ganancia</h2>
        <button type="button" class="btn-ghost btn-sm" id="g-cerrar">✕</button>
      </div>
      <div class="modal-body">
        <p class="muted" style="margin:0 0 10px">Suma al <b>profit</b> del reporte. <b>No</b> mueve el saldo (el dinero entra/sale por cargas y retiros).</p>
        <div class="grid grid-2">
          <div><label>Cajera</label>${seleccionable
            ? `<select name="cajera_id">${cajeraOpts}</select>`
            : `<input value="${esc(cajeraFija.nombre)}" disabled />`}</div>
          <div><label>Ganancia</label><input type="number" step="any" name="monto" placeholder="50000" required autofocus /></div>
        </div>
        <div style="margin-top:12px"><label>Nota (opcional)</label><input name="nota" placeholder="Bono retirado sin apostar" /></div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn-ghost" id="g-cancelar">Cancelar</button>
        <button type="submit" class="btn-primary">Cargar ganancia</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const f = $("#form-ganancia", dlg);
  const cerrar = () => { dlg.close(); dlg.remove(); };
  $("#g-cerrar", dlg).addEventListener("click", cerrar);
  $("#g-cancelar", dlg).addEventListener("click", cerrar);

  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const c = seleccionable ? state.cajeras.find((x) => x.id === f.cajera_id.value) : cajeraFija;
    if (!c) { alert("Elegí una cajera."); return; }
    const payload = { cajera_id: c.id, tipo: "Ganancia", monto: num(f.monto.value), bono_pct: 0, casa: null, nota: f.nota.value.trim() || null };
    if (guardarMovimiento(payload)) cerrar();
  });
}

function abrirMovimientos(c) {
  if (!c) return;
  // Movimientos manuales (cargas/retiros) + efectos derivados de las apuestas
  const items = [];
  state.movimientos.filter((m) => m.cajera_id === c.id).forEach((m) => {
    const bonoTxt = m.tipo === "Carga" && num(m.bono_pct) > 0 ? `bono ${num(m.bono_pct)}%` : "";
    const extra = m.tipo === "Ganancia" ? "no afecta saldo" : "";
    items.push({
      id: m.id, // manual → se puede borrar
      fecha: m.creado_en,
      tipo: m.tipo,
      detalle: [m.casa, bonoTxt, m.nota, extra].filter(Boolean).join(" · "),
      // Ganancia: muestra su monto (informativo); el saldo no cambia
      efecto: m.tipo === "Ganancia" ? num(m.monto) : efectoMovimiento(m),
    });
  });
  state.apuestas.filter((a) => a.cajera === c.nombre).forEach((a) => {
    const nombrePartido = a._partido ? a._partido.nombre : "—";
    const deb = debitoCajera(a);
    if (deb > 0) items.push({ fecha: a.creado_en, tipo: "Apuesta", detalle: nombrePartido, efecto: -deb });
    const cre = creditoCajera(a);
    if (cre > 0) items.push({ fecha: a.creado_en, tipo: "Premio", detalle: nombrePartido, efecto: cre });
  });
  items.sort((a, b) => String(b.fecha || "").localeCompare(String(a.fecha || "")));

  const rows = items.map((it) => `<tr>
    <td>${esc((it.fecha || "").slice(0, 10))}</td>
    <td>${esc(it.tipo)}</td>
    <td>${esc(it.detalle || "—")}</td>
    <td class="num ${it.efecto >= 0 ? "pos" : "neg"}">${it.efecto >= 0 ? "+" : ""}${money(it.efecto)}</td>
    <td>${it.id ? `<button type="button" class="btn-danger btn-sm" data-del-mov="${it.id}" title="Borrar movimiento">🗑️</button>` : ""}</td>
  </tr>`).join("");

  const dlg = document.createElement("dialog");
  dlg.innerHTML = `
    <form method="dialog" id="form-movs">
      <div class="modal-head">
        <h2 style="margin:0">📜 Movimientos · ${esc(c.nombre)}</h2>
        <button type="button" class="btn-ghost btn-sm" id="m-cerrar">✕</button>
      </div>
      <div class="modal-body">
        <div class="tbl-wrap"><table>
          <thead><tr><th>Fecha</th><th>Tipo</th><th>Detalle</th><th class="num">Monto</th><th></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="5" class="muted">Sin movimientos.</td></tr>`}</tbody>
        </table></div>
        <p class="muted" style="margin:10px 0 0">Solo se pueden borrar Cargas y Retiros. Apuesta/Premio salen de las apuestas.</p>
      </div>
      <div class="modal-foot">
        <button type="submit" class="btn-primary">Cerrar</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  const cerrar = () => { dlg.close(); dlg.remove(); };
  $("#m-cerrar", dlg).addEventListener("click", cerrar);
  $("#form-movs", dlg).addEventListener("submit", (e) => { e.preventDefault(); cerrar(); });
  $$("[data-del-mov]", dlg).forEach((b) => b.addEventListener("click", () => borrarMovimiento(b.dataset.delMov, c.id, dlg)));
}

async function borrarMovimiento(id, cajeraId, dlg) {
  if (!confirm("¿Borrar este movimiento? El saldo se recalcula.")) return;
  // Optimista: saco la fila y refresco al instante; el borrado real va atrás.
  const backup = [...state.movimientos];
  state.movimientos = state.movimientos.filter((m) => m.id !== id);
  render();
  dlg.close(); dlg.remove();
  const c = state.cajeras.find((x) => x.id === cajeraId);
  if (c) abrirMovimientos(c); // reabrir ya sin la fila

  setBusy(true);
  const { error } = await sb.from("movimientos").delete().eq("id", id);
  setBusy(false);
  if (error) {
    state.movimientos = backup; // revierte
    render();
    mostrarError("No se pudo borrar el movimiento: " + error.message);
  }
}

// Guarda un movimiento con actualización OPTIMISTA: valida, agrega la fila al
// estado y refresca la UI al instante (el popup se cierra enseguida); la inserción
// real va en segundo plano. Si el servidor la rechaza, revierte y avisa.
// Devuelve true si pasó la validación (para que el modal se cierre).
function guardarMovimiento(payload) {
  if (!sb) { alert("Primero configurá Supabase en config.js"); return false; }
  if (!(num(payload.monto) > 0)) { alert("Ingresá un monto mayor a 0."); return false; }

  // Fila optimista (con id temporal) para ver el cambio ya.
  const tempId = "tmp-" + (++_tmpSeq);
  state.movimientos.unshift({ ...payload, id: tempId, creado_en: new Date().toISOString() });
  render();

  // Persiste en segundo plano y reconcilia.
  setBusy(true);
  sb.from("movimientos").insert(payload).select().single()
    .then(({ data, error }) => {
      const i = state.movimientos.findIndex((m) => m.id === tempId);
      if (error) {
        if (i >= 0) state.movimientos.splice(i, 1); // revierte
        mostrarError("No se pudo guardar el movimiento: " + error.message);
      } else if (i >= 0) {
        state.movimientos[i] = data; // reemplaza por la fila real (id definitivo)
      }
      render();
    })
    .finally(() => setBusy(false));

  return true;
}

// ============================================================
//   VISTA: CONFIGURACIÓN (casas y cajeras)
// ============================================================
// Opciones de casino para una cajera (prioriza casas con cajeras)
function opcionesCasaCajera(selId) {
  const conCajeras = state.casas.filter((x) => x.tiene_cajeras);
  const lista = conCajeras.length ? conCajeras : state.casas;
  return `<option value="">— casino —</option>` +
    lista.map((x) => `<option value="${x.id}" ${x.id === selId ? "selected" : ""}>${esc(x.nombre)}</option>`).join("");
}

function viewConfig() {
  const casas = state.casas.map((c) => `<div class="cajera-cfg">
    <span class="cajera-cfg-nombre">${esc(c.nombre)}<span class="muted">${c.tiene_cajeras ? " · 💰 cajeras" : ""}${c.permite_gratis ? " · 🎁 gratis" : ""}</span></span>
    <label class="muted" style="display:flex;align-items:center;gap:6px;white-space:nowrap">Bono % <input type="number" step="any" data-bono-casa="${c.id}" value="${num(c.bono_pct)}" style="width:80px" /></label>
    <button class="btn-danger btn-sm" data-del-casa="${c.id}" title="Borrar">✕</button>
  </div>`).join("");
  const cajeras = state.cajeras.map((c) => `<div class="cajera-cfg">
    <span class="cajera-cfg-nombre">${esc(c.nombre)}</span>
    <select data-casa-cajera="${c.id}">${opcionesCasaCajera(c.casa_id)}</select>
    <button class="btn-danger btn-sm" data-del-cajera="${c.id}" title="Borrar">✕</button>
  </div>`).join("");

  return `
    <div class="card">
      <h2>Casas de apuestas</h2>
      <div style="margin-bottom:14px">${casas || `<span class="muted">Sin casas</span>`}</div>
      <div class="row">
        <div class="field"><label>Nombre</label><input id="casa-nombre" placeholder="Ej. Vira" /></div>
        <div class="field"><label>Bono % (al depositar)</label><input id="casa-bono" type="number" step="any" value="0" /></div>
        <label style="display:flex;align-items:center;gap:6px;color:var(--text);cursor:pointer;white-space:nowrap">
          <input type="checkbox" id="casa-cajeras" style="width:auto" /> 💰 Tiene cajeras (descuenta saldo)
        </label>
        <label style="display:flex;align-items:center;gap:6px;color:var(--text);cursor:pointer;white-space:nowrap">
          <input type="checkbox" id="casa-gratis" style="width:auto" /> 🎁 Da apuesta gratis
        </label>
        <button class="btn-primary" id="add-casa">Agregar casa</button>
      </div>
    </div>
    <div class="card">
      <h2>Cajeras</h2>
      <div style="margin-bottom:14px">${cajeras || `<span class="muted">Sin cajeras</span>`}</div>
      <div class="row">
        <div class="field"><label>Nombre</label><input id="cajera-nombre" placeholder="Ej. Julieta Principal Daalber" /></div>
        <div class="field"><label>Casino</label><select id="cajera-casa">${opcionesCasaCajera(null)}</select></div>
        <button class="btn-primary" id="add-cajera">Agregar cajera</button>
      </div>
    </div>
  `;
}

function bindConfig() {
  $("#add-casa")?.addEventListener("click", async () => {
    const nombre = $("#casa-nombre").value.trim();
    if (!nombre) return;
    const { error } = await sb.from("casas").insert({
      nombre,
      bono_pct: num($("#casa-bono").value),
      tiene_cajeras: $("#casa-cajeras").checked,
      permite_gratis: $("#casa-gratis").checked,
    });
    if (error) { alert("Error: " + error.message); return; }
    await cargarTodo(); render();
  });
  $("#add-cajera")?.addEventListener("click", async () => {
    const nombre = $("#cajera-nombre").value.trim();
    if (!nombre) return;
    const { error } = await sb.from("cajeras").insert({ nombre, casa_id: $("#cajera-casa").value || null });
    if (error) { alert("Error: " + error.message); return; }
    await cargarTodo(); render();
  });
  $$("[data-casa-cajera]").forEach((sel) => sel.addEventListener("change", async () => {
    const { error } = await sb.from("cajeras").update({ casa_id: sel.value || null }).eq("id", sel.dataset.casaCajera);
    if (error) { alert("Error: " + error.message); return; }
    await cargarTodo(); render();
  }));
  $$("[data-bono-casa]").forEach((inp) => inp.addEventListener("change", async () => {
    const { error } = await sb.from("casas").update({ bono_pct: num(inp.value) }).eq("id", inp.dataset.bonoCasa);
    if (error) { alert("Error: " + error.message); return; }
    await cargarTodo(); render();
  }));
  $$("[data-del-casa]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("¿Borrar casa?")) return;
    await sb.from("casas").delete().eq("id", b.dataset.delCasa);
    await cargarTodo(); render();
  }));
  $$("[data-del-cajera]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("¿Borrar cajera?")) return;
    await sb.from("cajeras").delete().eq("id", b.dataset.delCajera);
    await cargarTodo(); render();
  }));
}

// ============================================================
//   ARRANQUE
// ============================================================
$$(".tab").forEach((t) => t.addEventListener("click", () => { state.tab = t.dataset.tab; render(); }));

// Feedback inmediato al enviar un formulario dentro de un modal: el botón de
// submit muestra spinner y se deshabilita mientras se guarda. Si el modal sigue
// abierto (ej. error de validación), se reactiva solo a los pocos segundos.
document.addEventListener("submit", (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement) || !form.closest("dialog")) return;
  const btn = form.querySelector('button[type="submit"], button:not([type])');
  if (!btn || btn.classList.contains("is-loading")) return;
  btn.classList.add("is-loading");
  btn.disabled = true;
  setTimeout(() => { btn.classList.remove("is-loading"); btn.disabled = false; }, 6000);
}, true);

(async function init() {
  render();
  if (sb) { await cargarTodo(); render(); }
})();
