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
  admins: [],         // {id, nombre} — dueños de cajeros/cuentas (para agrupar/filtrar)
  adminsById: {},     // id -> admin
  cajeras: [],        // {id, nombre, casa_id, es_cuenta, admin_id}
  partidos: [],       // {id, nombre, fecha, hora, resultado_ganador}
  partidosById: {},   // id -> partido
  movimientos: [],    // {id, cajera_id, tipo, monto, bono_pct, nota, creado_en}
  retirosGanancia: [],// {id, monto, nota, creado_en} — reparto de ganancias (baja el profit actual)
  transferencias: [], // {id, origen_id, destino_id, origen_nombre, destino_nombre, monto, comision_pct, comision, nota, creado_en}
  config: {},         // ajustes globales clave->valor (ej. comision_cuenta_pct)
  apuestas: [],       // {id, partido_id, cajera, premio_cobrado, notas, lineas:[...], _partido}
  partidosColapsados: new Set(), // ids de partidos colapsados (por defecto van desplegados)
  pagina: 1,          // paginado del listado de partidos
  filtroEstado: "Pendiente",  // estado de partido ("" = todos | "Pendiente" | "Finalizado")
  filtroRep: { periodo: "todo", desde: "", hasta: "", cajera: "", montoMin: "", montoMax: "" },
  cajerasTab: "cajero", // "cajero" | "cuenta" — sub-tab del panel de Cajeras
  filtroAdmin: "",    // "" = todos · "none" = sin admin · <id> = ese admin
  filtroCasa: "",     // "" = todos · <id> = ese casino (solo aplica a Cajeros)
};

// Admin (dueño) de una cajera/cuenta, o null.
const adminDeCajera = (c) => (c && c.admin_id ? state.adminsById[c.admin_id] : null);

// % de comisión que cobran las cuentas por transferencia (global, configurable).
const COMISION_CUENTA_DEFAULT = 5;
function comisionCuentaPct() {
  const v = state.config.comision_cuenta_pct;
  return v != null && v !== "" ? num(v) : COMISION_CUENTA_DEFAULT;
}
const esCuenta = (c) => !!(c && c.es_cuenta);

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
// Formatea un timestamp ISO (creado_en) a fecha y hora locales: "2026-07-08" / "14:30".
const fmtFechaHoraPartes = (iso) => {
  if (!iso) return { fecha: "—", hora: "" };
  const d = new Date(iso);
  if (isNaN(d)) return { fecha: String(iso).slice(0, 10), hora: "" };
  const p = (n) => String(n).padStart(2, "0");
  return {
    fecha: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    hora: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
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
// Ordena una lista de partidos según su estado: pendientes por fecha/hora
// ascendente (el próximo primero), finalizados descendente (el más reciente
// primero). En una lista mixta ("Todos"), los pendientes van arriba.
const ordenarPartidosPorEstado = (arr) => {
  const pend = ordenarPartidos(arr.filter((p) => estadoPartido(p) === "Pendiente"));
  const fin = ordenarPartidos(arr.filter((p) => estadoPartido(p) === "Finalizado")).reverse();
  return [...pend, ...fin];
};
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

// Bono estimado generado por un partido (suma de sus apuestas). Se calcula EN VIVO
// con el bono% actual de cada casa (cambia si se edita el bono).
function bonoEstimadoPartido(p) {
  return apuestasDePartido(p.id).reduce((s, a) => s + bonoEstimadoApuesta(a), 0);
}

// Bono de depósito que aporta un partido al profit:
// - Si ya se resolvió (bono_apuestas guardado, no null) → usa ese SNAPSHOT (congelado
//   al resolver; editar el bono de una casa después NO lo cambia).
// - Si todavía no tiene snapshot (pendiente, o resuelto antes de esta feature) → en vivo.
function bonoPartido(p) {
  return p && p.bono_apuestas != null ? num(p.bono_apuestas) : bonoEstimadoPartido(p);
}

// Base sobre la que se calcula el bono de depósito: Σ monto apostado en líneas
// de casas que dan bono (ej. Vira). El bono editable es un % de esta base.
function baseBonoPartido(p) {
  return apuestasDePartido(p.id).reduce((s, a) => s + (a.lineas || []).reduce((t, l) => {
    const casa = state.casas.find((x) => x.nombre === l.casa);
    return t + (casa && num(casa.bono_pct) > 0 ? num(l.monto_cargado) : 0);
  }, 0), 0);
}

// % de bono por defecto de un partido: el de la casa (con bono) que aporta más
// monto entre sus líneas. 0 si ninguna casa da bono.
function bonoPctPartido(p) {
  const porPct = {};
  apuestasDePartido(p.id).forEach((a) => (a.lineas || []).forEach((l) => {
    const casa = state.casas.find((x) => x.nombre === l.casa);
    const bp = casa ? num(casa.bono_pct) : 0;
    if (bp > 0) porPct[bp] = (porPct[bp] || 0) + num(l.monto_cargado);
  }));
  let mejor = 0, max = -1;
  Object.entries(porPct).forEach(([bp, monto]) => { if (monto > max) { max = monto; mejor = num(bp); } });
  return mejor;
}

// Bono de depósito a partir de un % (el bono va "adentro" del monto apostado):
// base × pct/(100+pct). Ej: base 480.000 al 20% → 80.000.
function bonoDesdePct(base, pct) {
  return pct > 0 ? base * pct / (100 + pct) : 0;
}

// Cajeras distintas (objetos) que participan en las apuestas de un partido.
function cajerasDePartido(p) {
  const nombres = [...new Set(apuestasDePartido(p.id).map((a) => a.cajera).filter(Boolean))];
  return nombres
    .map((nombre) => state.cajeras.find((x) => x.nombre === nombre))
    .filter(Boolean);
}

// Cajeras distintas del partido que tienen el "saldo de retiro" activado.
function cajerasConRetiroDePartido(p) {
  return cajerasDePartido(p).filter((c) => c.saldo_retiro);
}

// Bono por "saldo de retiro" al resolver: por cada cajera distinta del partido
// con el flag saldo_retiro activado, (saldo actual) × (bono% de su casino) / 100.
// Se evalúa con los saldos del momento (al resolver se guarda como snapshot).
function bonoRetiroPartido(p) {
  return cajerasConRetiroDePartido(p).reduce((s, c) => {
    const casa = casaDeCajera(c);
    const bp = casa ? num(casa.bono_pct) : 0;
    return s + resumenCajera(c).saldo * bp / 100;
  }, 0);
}

// HTML del "premio por resultado": por cada resultado posible, el premio total
// que se cobraría (suma de todas las apuestas del partido) si sale ese resultado.
// Solo en partidos pendientes con resultados cargados.
function premioPorResultadoHtml(p, est) {
  if (est !== "Pendiente") return "";
  const bal = balancePartido(p).sort((a, b) => b.premio - a.premio);
  if (!bal.length) return "";
  return `<div class="partido-balance">
    <span class="bal-title">Premio por resultado:</span>
    ${bal.map((b) => `<span class="bal-item"><span class="bal-res">${esc(b.resultado)}</span> <b class="pos">${money(b.premio)}</b></span>`).join("")}
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

  // Transferencias: el origen pierde el monto completo; el destino recibe el neto
  // (monto − comisión). La comisión no vuelve a nadie (es gasto, va contra profit).
  const transferOut = state.transferencias
    .filter((t) => t.origen_id === c.id).reduce((s, t) => s + num(t.monto), 0);
  const transferIn = state.transferencias
    .filter((t) => t.destino_id === c.id)
    .reduce((s, t) => s + (num(t.monto) - num(t.comision) + num(t.bono_destino)), 0);

  // Apostar descuenta; ganar y cargar suman; retirar y transferir a otro restan.
  // El saldo nunca queda negativo: piso en 0.
  const saldo = Math.max(0, cargado + ganado - apostado - retirado + transferIn - transferOut);
  return { saldo, cargado, retirado, apostado, ganado, transferIn, transferOut, nApuestas: aps.length };
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
  state.transferencias.forEach((t) => { if (t.origen_id === c.id || t.destino_id === c.id) considerar(t.creado_en); });
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
  // Config + transferencias + admins: tolerante (si falta la migración, defaultea
  // a vacío en vez de romper toda la carga).
  const [cfg, transf, admins] = await Promise.all([
    sb.from("config").select("*"),
    sb.from("transferencias").select("*").order("creado_en", { ascending: false }),
    sb.from("admins").select("*").order("nombre"),
  ]);
  state.config = {};
  if (!cfg.error) cfg.data.forEach((r) => { state.config[r.clave] = r.valor; });
  state.transferencias = transf.error ? [] : transf.data;
  state.admins = admins.error ? [] : admins.data;
  state.adminsById = {};
  state.admins.forEach((a) => { state.adminsById[a.id] = a; });
  congelarBonosResueltos();
  } finally {
    setBusy(false);
  }
}

// Backfill: los partidos ya resueltos que todavía no tienen el bono de depósito
// congelado (bono_apuestas == null) se congelan con su valor actual, para que
// editar el bono% de una casa deje de mover el profit histórico hacia atrás.
// Congela con el valor de AHORA, así el número mostrado no cambia en el momento.
function congelarBonosResueltos() {
  if (!sb) return;
  const pend = state.partidos.filter((p) => p.resultado_ganador && p.bono_apuestas == null);
  pend.forEach((p) => {
    const v = bonoEstimadoPartido(p);
    p.bono_apuestas = v; // congela en memoria
    sb.from("partidos").update({ bono_apuestas: v }).eq("id", p.id)
      .then((r) => { if (r && r.error) p.bono_apuestas = null; }); // revierte si falla (ej. falta migración)
  });
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

// Tiempo transcurrido en texto: "recién", "Hace 5 minutos", "Hace 1 hora",
// "Hace 1 día 5 horas". Para días incluye las horas restantes.
function tiempoRelativo(ms) {
  if (!ms) return "";
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return "recién";
  if (min < 60) return `Hace ${min} ${min === 1 ? "minuto" : "minutos"}`;
  const horas = Math.floor(min / 60);
  if (horas < 24) return `Hace ${horas} ${horas === 1 ? "hora" : "horas"}`;
  const dias = Math.floor(horas / 24);
  const horasResto = horas % 24;
  let s = `Hace ${dias} ${dias === 1 ? "día" : "días"}`;
  if (horasResto > 0) s += ` ${horasResto} ${horasResto === 1 ? "hora" : "horas"}`;
  return s;
}

// Duración en texto corto para cuenta regresiva: "3 h 20 m", "45 min".
function fmtDuracion(ms) {
  const totalMin = Math.max(1, Math.ceil(ms / 60000));
  const horas = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (horas >= 1) return `${horas} h${min > 0 ? ` ${min} m` : ""}`;
  return `${min} min`;
}

// Estado del retiro de una cajera: se puede retirar cada 24 h desde el último
// retiro. Devuelve { disponible, faltaMs, ultimo } (ultimo en ms, 0 si nunca).
const RETIRO_INTERVALO_MS = 24 * 60 * 60 * 1000;
function estadoRetiroCajera(c) {
  let ultimo = 0;
  state.movimientos.forEach((m) => {
    if (m.cajera_id === c.id && m.tipo === "Retiro" && m.creado_en) {
      const t = Date.parse(m.creado_en);
      if (!isNaN(t) && t > ultimo) ultimo = t;
    }
  });
  if (!ultimo) return { disponible: true, faltaMs: 0, ultimo: 0 };
  const falta = ultimo + RETIRO_INTERVALO_MS - Date.now();
  return { disponible: falta <= 0, faltaMs: Math.max(0, falta), ultimo };
}

function actualizarUltimaAct() {
  const el = $("#ultima-act");
  if (!el) return;
  const ms = ultimaActualizacionGlobal();
  el.innerHTML = ms ? `Última actualización: <b>${fechaHora(ms)}</b> · ${tiempoRelativo(ms)}` : "";
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
  $$("[data-tab]").forEach((t) => t.classList.toggle("active", t.dataset.tab === state.tab));
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
  const optCajera = state.cajeras.filter((c) => !esCuenta(c)).map((c) => `<option ${f.cajera === c.nombre ? "selected" : ""}>${esc(c.nombre)}</option>`).join("");
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

  // Partidos resueltos dentro del alcance de los filtros (para el bono de depósito,
  // que ahora es un snapshot por partido). Con filtro de cajera se omite (igual que
  // el bono por saldo de retiro): no se puede subdividir por cajera.
  const partidosResueltosScope = state.filtroRep.cajera ? [] :
    [...new Set(resueltas.map((x) => x.a.partido_id).filter(Boolean))]
      .map((pid) => state.partidosById[pid]).filter(Boolean);
  const bonoPorPartidoMes = {};
  partidosResueltosScope.forEach((p) => {
    const k = (p.fecha || "").slice(0, 7) || "sin fecha";
    bonoPorPartidoMes[k] = (bonoPorPartidoMes[k] || 0) + bonoPartido(p);
  });

  const porMes = {};
  resueltas.forEach((x) => {
    const fecha = apuestaFecha(x.a);
    const k = fecha ? fecha.slice(0, 7) : "sin fecha";
    (porMes[k] ||= { profit: 0, n: 0 });
    porMes[k].profit += x.c.profit; // solo profit real; el bono de depósito se suma por partido
    porMes[k].n++;
  });
  // Suma el bono de depósito (snapshot por partido) al mes correspondiente
  Object.entries(bonoPorPartidoMes).forEach(([k, v]) => {
    (porMes[k] ||= { profit: 0, n: 0 }).profit += v;
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

  // Profit total = profit real de resueltas + bono de depósito (snapshot por partido) + ganancias manuales
  const bonoGanado = partidosResueltosScope.reduce((s, p) => s + bonoPartido(p), 0);
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
  // Bono por saldo de retiro: snapshot guardado por partido al resolver. Suma al
  // histórico. Es un agregado por partido, así que con filtro de cajera se omite
  // (no se puede subdividir). Filtra por la fecha del partido dentro del período.
  const bonoRetiroTotal = f.cajera ? 0 : state.partidos
    .filter((p) => p.resultado_ganador)
    .filter((p) => {
      const fecha = p.fecha || "";
      if (desde && fecha && fecha < desde) return false;
      if (hasta && fecha && fecha > hasta) return false;
      return true;
    })
    .reduce((s, p) => s + num(p.bono_retiro), 0);
  // Comisiones de cuentas (gasto real): bajan el profit HISTÓRICO (y por lo tanto
  // el actual). Respeta período por creado_en. Con filtro de cajera se omite
  // (es un gasto global entre cajero/cuenta, no atribuible a una sola cajera).
  const comisionesTotal = f.cajera ? 0 : state.transferencias.filter((t) => {
    const fecha = (t.creado_en || "").slice(0, 10);
    if (desde && fecha < desde) return false;
    if (hasta && fecha > hasta) return false;
    return true;
  }).reduce((s, t) => s + num(t.comision), 0);
  const profitConBono = profitTotal + bonoGanado + gananciaManual + bonoRetiroTotal - comisionesTotal;
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
      <button class="btn-ghost btn-sm" id="ver-transferencias">🔁 Transferencias (${state.transferencias.length})</button>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="label">Profit total actual</div><div class="value ${profitActual >= 0 ? "pos" : "neg"}">${money(profitActual)}</div></div>
      <div class="kpi"><div class="label">Profit total histórico</div><div class="value ${profitConBono >= 0 ? "pos" : "neg"}">${money(profitConBono)}</div></div>
      <div class="kpi"><div class="label">Transferencia recibido</div><div class="value pos">${money(transferencia)}</div></div>
      <div class="kpi"><div class="label">Total ingresado</div><div class="value">${money(ingresadoTotal)}</div></div>
      <div class="kpi"><div class="label">Total saldo cajeras actual</div><div class="value ${saldoCajeras >= 0 ? "pos" : "neg"}">${money(saldoCajeras)}</div></div>
      <div class="kpi"><div class="label">Total en apuestas pendientes</div><div class="value">${money(pendientesTotal)}<span class="muted" style="font-size:14px"> · ${pendientes.length}</span></div></div>
      ${comisionesTotal > 0 ? `<div class="kpi"><div class="label">Comisiones cuentas</div><div class="value neg">−${money(comisionesTotal)}</div></div>` : ""}
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
  $("#ver-transferencias")?.addEventListener("click", () => abrirTransferencias());
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

  // Pendientes: fecha/hora ascendente (el próximo primero).
  // Finalizados: descendente (el más reciente primero).
  // "Todos": pendientes arriba (ascendente) y finalizados abajo (descendente).
  const filtrados = state.filtroEstado
    ? state.partidos.filter((p) => estadoPartido(p) === state.filtroEstado)
    : state.partidos;
  const lista = ordenarPartidosPorEstado(filtrados);

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
  const profitCell = pend ? "" : (c.profit == null ? "—" : money(c.profit));
  // Saldo actual de la cajera (chico y gris), junto al nombre
  const cajObj = state.cajeras.find((x) => x.nombre === a.cajera);
  const saldoTxt = cajObj
    ? ` <span class="saldo-inline">· Saldo actual: ${money(resumenCajera(cajObj).saldo)}</span>`
    : "";
  // Cajera con "saldo de retiro" activado → nombre en verde (lista para retirar)
  const conRetiro = !!(cajObj && cajObj.saldo_retiro);
  const nombreHtml = `<span class="cajera-nombre ${conRetiro ? "retiro-ok" : ""}">${esc(a.cajera || "—")}${conRetiro ? ` <span class="retiro-tick" title="Saldo de retiro listo">✓</span>` : ""}</span>`;
  return `<tr>
    <td data-label="Cajera">${nombreHtml}${saldoTxt}</td>
    <td data-label="Resultado / Cuota">${lineasApuestaHtml(a)}</td>
    <td class="num" data-label="Ingresado">${money(c.ingresado)}</td>
    <td class="num" data-label="${pend ? "Premio potencial" : "Premio"}">${premioCell}</td>
    <td class="num ${pend ? "empty-cell" : c.profit == null ? "" : c.profit >= 0 ? "pos" : "neg"}" data-label="Profit">${profitCell}</td>
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
  const bonoEst = bonoPartido(p); // snapshot si está resuelto; estimado en vivo si pendiente
  const bonoRet = num(p.bono_retiro);
  const bonoTotal = bonoEst + bonoRet;
  const abierto = !state.partidosColapsados.has(p.id);
  const filas = cp.aps.map(filaApuesta).join("");
  const fechaTxt = [p.fecha || "", p.hora ? fmtHora(p.hora) : ""].filter(Boolean).join(" · ");

  return `<div class="card partido estado-${est}">
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
      ${bonoEst > 0 ? `<span>${est === "Finalizado" ? "Bono depósito" : "Bono estimado"}: <b class="pos">${money(bonoEst)}</b></span>` : ""}
      ${bonoRet > 0 ? `<span>Bono retiro: <b class="pos">${money(bonoRet)}</b></span>` : ""}
      ${cp.profitDef && bonoTotal > 0 ? `<span>Profit + bono${est === "Finalizado" ? "" : " (est.)"}: <b class="pos">${money(cp.profit + bonoTotal)}</b></span>` : ""}
    </div>
    ${abierto ? `
    ${premioPorResultadoHtml(p, est)}
    <button class="btn-ghost add-apuesta-btn" data-add-apuesta="${p.id}">+ Agregar apuesta</button>
    <div class="tbl-wrap">
      <table class="apuestas-tbl">
        <thead><tr>
          <th>Cajera</th><th>Resultado / Cuota</th><th class="num">Ingresado</th>
          <th class="num">Premio</th><th class="num">Profit</th><th></th>
        </tr></thead>
        <tbody>${filas || `<tr><td colspan="6" class="muted">Sin apuestas. Agregá la primera.</td></tr>`}</tbody>
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
  const opts = state.cajeras.filter((c) => !esCuenta(c)).map((c) => `<option ${c.nombre === sel ? "selected" : ""}>${esc(c.nombre)}</option>`).join("");
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
    const cajeraOpts = state.cajeras.filter((x) => !esCuenta(x)).map((x) => `<option ${x.nombre === l.cajera ? "selected" : ""}>${esc(x.nombre)}</option>`).join("");
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
      if (f === "cajera") {
        // Al elegir la cajera, autocompleta la casa con su casino asignado.
        const caj = state.cajeras.find((x) => x.nombre === inp.value);
        const casa = casaDeCajera(caj);
        if (casa) {
          modalLineas[i].casa = casa.nombre;
          if (!casaPermiteGratis(casa.nombre)) modalLineas[i].apuesta_gratis = "";
        }
        renderLineasNueva(dlg);
        actualizarResumenNueva(dlg);
        return;
      }
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
        <div id="r-bono-wrap" style="margin-top:14px; display:none">
          <label>Bono de depósito — % (se congela al guardar)</label>
          <input type="number" step="any" name="bono_pct" />
          <p class="muted" id="r-bono-info" style="margin:6px 0 0;font-size:12px"></p>
        </div>
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
    let totalProfit = 0;
    const rows = aps.map((a) => {
      const c = calcApuesta({ ...a, _partido: { resultado_ganador: res } });
      if (c.profit != null) totalProfit += c.profit;
      return `<tr>
        <td>${esc(a.cajera || "—")}</td>
        <td><span class="badge ${esc(c.estado)}">${esc(c.estado)}</span></td>
        <td class="num">${money(c.ingresado)}</td>
        <td class="num">${res ? money(c.premio) : "—"}</td>
        <td class="num ${c.profit == null ? "" : c.profit >= 0 ? "pos" : "neg"}">${c.profit == null ? "—" : money(c.profit)}</td>
      </tr>`;
    }).join("");
    $("#r-bono-wrap", dlg).style.display = res ? "block" : "none";
    const bonoPct = num(f.bono_pct.value);
    const bonoEst = res ? bonoDesdePct(baseBono, bonoPct) : 0;
    $("#r-bono-info", dlg).innerHTML = `Se calcula como % del ingresado en casas con bono (Vira): <b>${money(baseBono)}</b> → bono <b>${money(bonoDesdePct(baseBono, bonoPct))}</b>. Se congela al guardar; editar el bono de la casa después no lo cambia.`;
    const bonoRet = res ? bonoRetiroPartido(p) : 0;
    const totalConBono = totalProfit + bonoEst + bonoRet;
    // Totales (solo cuando se eligió un resultado)
    const totales = res ? `
      <div class="resolver-totales">
        <div class="rt-row"><span>Profit total cajeras</span><b class="${totalProfit >= 0 ? "pos" : "neg"}">${money(totalProfit)}</b></div>
        ${bonoEst > 0 ? `<div class="rt-row"><span>Bono de depósito</span><b class="pos">+${money(bonoEst)}</b></div>` : ""}
        ${bonoRet > 0 ? `<div class="rt-row"><span>Bono por saldo de retiro</span><b class="pos">+${money(bonoRet)}</b></div>` : ""}
        <div class="rt-total"><span>Total</span><b class="${totalConBono >= 0 ? "pos" : "neg"}">${money(totalConBono)}</b></div>
      </div>${bonoRet > 0 ? `<p class="muted" style="margin:8px 0 0;font-size:12px">Al guardar se desactiva el “saldo de retiro” de esas cajeras (se cuenta una sola vez).</p>` : ""}${!p.resultado_ganador ? `<p class="muted" style="margin:8px 0 0;font-size:12px">Al guardar, las cajeras de este partido quedan en <b style="color:var(--danger)">🔒 Pendiente de retiro</b> (rojas) hasta que hagas el retiro.</p>` : ""}` : "";
    $("#r-preview", dlg).innerHTML = `<div class="tbl-wrap"><table>
      <thead><tr><th>Cajera</th><th>Estado</th><th class="num">Ingresado</th><th class="num">Premio</th><th class="num">Profit</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="muted">Sin apuestas</td></tr>`}</tbody></table></div>${totales}`;
  };

  // Base y % por defecto del bono de depósito.
  const baseBono = baseBonoPartido(p);
  // Si ya está congelado, retro-calcula el % desde el monto guardado; si no, el % de la casa.
  const pctDefault = (p.bono_apuestas != null && baseBono > num(p.bono_apuestas))
    ? Math.round(num(p.bono_apuestas) * 100 / (baseBono - num(p.bono_apuestas)))
    : bonoPctPartido(p);
  f.bono_pct.value = pctDefault;
  f.resultado_ganador.addEventListener("change", preview);
  f.bono_pct.addEventListener("input", preview);
  preview();

  f.addEventListener("submit", (e) => {
    e.preventDefault();
    resolverPartido(dlg, p.id).then((ok) => { if (ok) cerrar(); });
  });
}

async function resolverPartido(dlg, id) {
  if (!sb) { alert("Primero configurá Supabase en config.js"); return false; }
  const f = $("#form-resolver", dlg);
  const p = state.partidosById[id];
  const res = f.resultado_ganador.value || null;
  const eraPendiente = !(p && p.resultado_ganador);
  const bonoApuestas = bonoDesdePct(baseBonoPartido(p), num(f.bono_pct.value));

  const update = { resultado_ganador: res };
  let cajerasConsumidas = [];
  let cajerasABloquear = [];
  if (res) {
    // Congela el bono de depósito editado en el popup (snapshot). No cambia
    // aunque después se edite el bono% de la casa.
    update.bono_apuestas = bonoApuestas;
  }
  if (res && eraPendiente) {
    // Primera resolución: snapshot del bono (saldos del momento) y se "consume"
    // el saldo de retiro de esas cajeras → se desactiva el check para no contarlo
    // de nuevo si la misma cajera está en otro partido sin resolver.
    update.bono_retiro = bonoRetiroPartido(p);
    cajerasConsumidas = cajerasConRetiroDePartido(p);
    // Todas las cajeras del partido quedan "pendientes de retiro" (rojas):
    // tienen saldo a la espera de retirar y no se deben tocar.
    cajerasABloquear = cajerasDePartido(p).filter((c) => !c.pendiente_retiro);
  } else if (!res) {
    update.bono_retiro = 0; // vuelve a pendiente: se anula el bono
    update.bono_apuestas = null; // vuelve a pendiente: se descongela
  }
  // re-resolución (ya estaba finalizado): mantiene el bono_retiro guardado

  const { error } = await sb.from("partidos").update(update).eq("id", id);
  if (error) { alert("Error: " + error.message); return false; }

  // Desactiva el saldo de retiro de las cajeras ya contabilizadas en este partido
  if (cajerasConsumidas.length) {
    await Promise.all(cajerasConsumidas.map((c) =>
      sb.from("cajeras").update({ saldo_retiro: false }).eq("id", c.id)));
  }

  // Activa "pendiente de retiro" en todas las cajeras del partido recién resuelto
  if (cajerasABloquear.length) {
    await Promise.all(cajerasABloquear.map((c) =>
      sb.from("cajeras").update({ pendiente_retiro: true }).eq("id", c.id)));
  }

  await cargarTodo();
  render();
  return true;
}

// ============================================================
//   VISTA: CAJERAS (saldo / billetera)
// ============================================================
function viewCajeras() {
  if (!state.cajeras.length) {
    return `<div class="card"><p class="muted">No hay cajeras ni cuentas todavía. Agregá una en la pestaña <b>Configuración</b>.</p></div>`;
  }
  // Filtro por admin (aplica a ambos sub-tabs) y por casino (solo Cajeros).
  const fAdmin = state.filtroAdmin;
  const pasaAdmin = (c) => fAdmin === "" || (fAdmin === "none" ? !c.admin_id : c.admin_id === fAdmin);
  const fCasa = state.filtroCasa;
  const pasaCasa = (c) => fCasa === "" || c.casa_id === fCasa;
  const cajeros = state.cajeras.filter((c) => !esCuenta(c) && pasaAdmin(c) && pasaCasa(c));
  const cuentas = state.cajeras.filter((c) => esCuenta(c) && pasaAdmin(c));
  const tab = state.cajerasTab === "cuenta" ? "cuenta" : "cajero";

  // Orden: actividad más reciente primero.
  const lista = (tab === "cuenta" ? cuentas : cajeros)
    .slice().sort((a, b) => ultimaActividadCajera(b) - ultimaActividadCajera(a));

  const chips = [["cajero", "Cajeros", cajeros.length], ["cuenta", "Cuentas", cuentas.length]]
    .map(([v, t, n]) => `<button class="chip-f ${tab === v ? "active" : ""}" data-cajtab="${v}">${t} <span class="chip-n">${n}</span></button>`).join("");

  const adminFiltro = state.admins.length ? `<div class="admin-filtro">
      <label class="muted" style="margin:0">Admin</label>
      <select id="filtro-admin">
        <option value="" ${fAdmin === "" ? "selected" : ""}>Todos</option>
        ${state.admins.map((a) => `<option value="${a.id}" ${fAdmin === a.id ? "selected" : ""}>${esc(a.nombre)}</option>`).join("")}
        <option value="none" ${fAdmin === "none" ? "selected" : ""}>Sin admin</option>
      </select>
    </div>` : "";
  // Filtro por casino: solo en el sub-tab Cajeros y solo con casinos marcados.
  const casasFiltro = state.casas.filter((x) => x.mostrar_filtro);
  const casaFiltro = (tab === "cajero" && casasFiltro.length) ? `<div class="admin-filtro">
      <label class="muted" style="margin:0">Casino</label>
      <select id="filtro-casa">
        <option value="" ${fCasa === "" ? "selected" : ""}>Todos</option>
        ${casasFiltro.map((x) => `<option value="${x.id}" ${fCasa === x.id ? "selected" : ""}>${esc(x.nombre)}</option>`).join("")}
      </select>
    </div>` : "";

  const cards = lista.length
    ? lista.map(tab === "cuenta" ? cardCuenta : cardCajero).join("")
    : `<div class="card"><p class="muted">${tab === "cuenta"
        ? "No hay cuentas. Creá una en Configuración marcando “👤 Es cuenta”."
        : "No hay cajeros todavía."}</p></div>`;

  const saldoTotal = lista.reduce((s, c) => s + resumenCajera(c).saldo, 0);

  const toolbar = tab === "cuenta"
    ? `<div class="toolbar">
        <button class="btn-primary" id="transferir">🔁 Transferir</button>
        <button class="btn-ghost" id="ver-transf">📜 Transferencias</button>
        <div class="spacer"></div>
        <span class="muted">Comisión ${comisionCuentaPct()}% · ${cuentas.length} cuenta(s)</span>
      </div>`
    : `<div class="toolbar">
        <button class="btn-primary" id="cargar-saldo">💵 Cargar saldo</button>
        <button class="btn-ghost" id="retirar-saldo">🏧 Retirar</button>
        <button class="btn-ghost" id="ganancia-manual">💰 Ganancia</button>
        <button class="btn-ghost" id="transferir">🔁 Transferir</button>
        <div class="spacer"></div>
        <span class="muted">${cajeros.length} cajero(s)</span>
      </div>`;

  const apostadoTotal = tab === "cuenta" ? 0
    : lista.reduce((s, c) => s + partidosPendientesCajera(c).reduce((t, x) => t + x.monto, 0), 0);

  return `<div class="card">
      <div class="kpis">
        <div class="kpi"><div class="label">Saldo total ${tab === "cuenta" ? "cuentas" : "cajeros"}</div><div class="value ${saldoTotal >= 0 ? "pos" : "neg"}">${money(saldoTotal)}</div></div>
        ${tab === "cuenta" ? "" : `<div class="kpi"><div class="label">Total apostado</div><div class="value">${money(apostadoTotal)}</div></div>`}
      </div>
    </div>
    <div class="chips-filtro">${chips}${casaFiltro}${adminFiltro}</div>
    ${toolbar}${cards}`;
}

// Card de un cajero (billetera para apostar): saldo, toggles de retiro, pendientes.
function cardCajero(c) {
  const r = resumenCajera(c);
  const casa = casaDeCajera(c);
  const pend = partidosPendientesCajera(c);
  const apostadoPend = pend.reduce((s, x) => s + x.monto, 0);
  const conRetiro = !!c.saldo_retiro;
  const conPendiente = !!c.pendiente_retiro;
  const er = estadoRetiroCajera(c);
  const admin = adminDeCajera(c);
  return `<div class="card cajera ${conRetiro ? "con-retiro" : ""} ${conPendiente ? "pendiente-retiro" : ""}">
      <div class="cajera-head">
        <div class="cajera-title">
          <h2 style="margin:0">${esc(c.nombre)}${casa ? ` <span class="muted" style="font-size:13px;font-weight:400">· ${esc(casa.nombre)}</span>` : ""}${admin ? ` <span class="muted" style="font-size:13px;font-weight:400">· admin ${esc(admin.nombre)}</span>` : ""}</h2>
          <div class="retiro-toggles">
            <label class="retiro-toggle ${conRetiro ? "on" : ""}" title="Marcar cuando la cajera ya tiene saldo cargado para retirar">
              <input type="checkbox" data-retiro-toggle="${c.id}" ${conRetiro ? "checked" : ""} />
              ${conRetiro ? "✓ Saldo de retiro" : "Sin saldo de retiro"}
            </label>
            <label class="retiro-toggle pend ${conPendiente ? "on" : ""}" title="Marcar para bloquear: tiene saldo pendiente de retirar y no se debe tocar hasta hacer el retiro">
              <input type="checkbox" data-pendiente-toggle="${c.id}" ${conPendiente ? "checked" : ""} />
              ${conPendiente ? "🔒 Pendiente de retiro" : "Sin pendiente de retiro"}
            </label>
          </div>
        </div>
        <div class="acc-right">
          <button class="btn-primary btn-sm" data-cargar="${c.id}">💵 Cargar</button>
          <button class="btn-ghost btn-sm" data-retirar="${c.id}">🏧 Retirar</button>
          <button class="btn-ghost btn-sm" data-ganancia="${c.id}">💰 Ganancia</button>
          <button class="btn-ghost btn-sm" data-movs="${c.id}">📜 Movimientos</button>
        </div>
      </div>
      <div class="cajera-saldo">
        <span class="label">Saldo disponible</span>
        <span class="value ${conPendiente ? "bloqueado" : r.saldo >= 0 ? "pos" : "neg"}">${money(r.saldo)}</span>
      </div>
      ${er.disponible
        ? `<div class="retiro-badge ok">✅ Retiro disponible</div>`
        : `<div class="retiro-badge wait">⏳ Retiro disponible en ${fmtDuracion(er.faltaMs)}</div>`}
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
}

// Card de una cuenta (persona): saldo administrado + neto recibido/enviado. No apuesta.
function cardCuenta(c) {
  const r = resumenCajera(c);
  const admin = adminDeCajera(c);
  return `<div class="card cajera cuenta">
      <div class="cajera-head">
        <div class="cajera-title">
          <h2 style="margin:0">${esc(c.nombre)} <span class="muted" style="font-size:13px;font-weight:400">· 👤 Cuenta${admin ? ` · admin ${esc(admin.nombre)}` : ""}</span></h2>
        </div>
        <div class="acc-right">
          <button class="btn-primary btn-sm" data-transf="${c.id}">🔁 Transferir</button>
          <button class="btn-ghost btn-sm" data-movs="${c.id}">📜 Movimientos</button>
        </div>
      </div>
      <div class="cajera-saldo">
        <span class="label">Saldo en la cuenta</span>
        <span class="value ${r.saldo >= 0 ? "pos" : "neg"}">${money(r.saldo)}</span>
      </div>
      <div class="cajera-desglose">
        <span>Recibido (neto) <b>${money(r.transferIn)}</b></span>
        <span>Enviado <b>${money(r.transferOut)}</b></span>
      </div>
    </div>`;
}

function bindCajeras() {
  const byId = (id) => state.cajeras.find((c) => c.id === id);
  $$("[data-cajtab]").forEach((b) => b.addEventListener("click", () => { state.cajerasTab = b.dataset.cajtab; render(); }));
  $("#filtro-admin")?.addEventListener("change", (e) => { state.filtroAdmin = e.target.value; render(); });
  $("#filtro-casa")?.addEventListener("change", (e) => { state.filtroCasa = e.target.value; render(); });
  $("#cargar-saldo")?.addEventListener("click", () => abrirCargar(null));
  $("#retirar-saldo")?.addEventListener("click", () => abrirRetirar(null));
  $("#ganancia-manual")?.addEventListener("click", () => abrirGanancia(null));
  $("#transferir")?.addEventListener("click", () => abrirTransferir(null));
  $("#ver-transf")?.addEventListener("click", () => abrirTransferencias());
  $$("[data-ganancia]").forEach((b) => b.addEventListener("click", () => abrirGanancia(byId(b.dataset.ganancia))));
  $$("[data-cargar]").forEach((b) => b.addEventListener("click", () => abrirCargar(byId(b.dataset.cargar))));
  $$("[data-retirar]").forEach((b) => b.addEventListener("click", () => abrirRetirar(byId(b.dataset.retirar))));
  $$("[data-transf]").forEach((b) => b.addEventListener("click", () => abrirTransferir(byId(b.dataset.transf))));
  $$("[data-movs]").forEach((b) => b.addEventListener("click", () => abrirMovimientos(byId(b.dataset.movs))));
  $$("[data-retiro-toggle]").forEach((cb) => cb.addEventListener("change", () => toggleSaldoRetiro(cb.dataset.retiroToggle, cb.checked)));
  $$("[data-pendiente-toggle]").forEach((cb) => cb.addEventListener("change", () => togglePendienteRetiro(cb.dataset.pendienteToggle, cb.checked)));
}

// Marca/desmarca el "saldo de retiro" de una cajera (optimista; revierte si falla).
async function toggleSaldoRetiro(cajeraId, valor) {
  const c = state.cajeras.find((x) => x.id === cajeraId);
  if (!c) return;
  c.saldo_retiro = valor; // optimista
  render();
  setBusy(true);
  const { error } = await sb.from("cajeras").update({ saldo_retiro: valor }).eq("id", cajeraId);
  setBusy(false);
  if (error) {
    c.saldo_retiro = !valor; // revierte
    render();
    mostrarError("No se pudo actualizar el saldo de retiro: " + error.message);
  }
}

// Marca/desmarca "pendiente de retiro" (bloqueo visual rojo; optimista, revierte si falla).
async function togglePendienteRetiro(cajeraId, valor) {
  const c = state.cajeras.find((x) => x.id === cajeraId);
  if (!c) return;
  c.pendiente_retiro = valor; // optimista
  render();
  setBusy(true);
  const { error } = await sb.from("cajeras").update({ pendiente_retiro: valor }).eq("id", cajeraId);
  setBusy(false);
  if (error) {
    c.pendiente_retiro = !valor; // revierte
    render();
    mostrarError("No se pudo actualizar el pendiente de retiro: " + error.message);
  }
}

// cajeraFija opcional: si no se pasa, el popup muestra un selector de cajera
function abrirCargar(cajeraFija) {
  if (!state.cajeras.length) { alert("No hay cajeras. Agregá una en Configuración."); return; }
  const seleccionable = !cajeraFija;
  const cajeraOpts = state.cajeras.filter((x) => !esCuenta(x))
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
  const cajeraOpts = state.cajeras.filter((x) => !esCuenta(x))
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
  const cajeraOpts = state.cajeras.filter((x) => !esCuenta(x))
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
  // Transferencias donde participa (origen o destino).
  state.transferencias.filter((t) => t.origen_id === c.id || t.destino_id === c.id).forEach((t) => {
    const esOrigen = t.origen_id === c.id;
    const otro = esOrigen ? (t.destino_nombre || "—") : (t.origen_nombre || "—");
    items.push({
      fecha: t.creado_en,
      tipo: "Transferencia",
      detalle: esOrigen
        ? `→ ${otro}${num(t.comision) > 0 ? ` · comisión ${money(num(t.comision))}` : ""}`
        : `← ${otro}${num(t.bono_destino) > 0 ? ` · bono ${money(num(t.bono_destino))}` : ""}`,
      efecto: esOrigen ? -num(t.monto) : (num(t.monto) - num(t.comision) + num(t.bono_destino)),
    });
  });
  items.sort((a, b) => String(b.fecha || "").localeCompare(String(a.fecha || "")));

  const rows = items.map((it) => {
    const fh = fmtFechaHoraPartes(it.fecha);
    return `<tr>
    <td><div>${esc(fh.fecha)}</div>${fh.hora ? `<div class="muted" style="font-size:12px">${esc(fh.hora)} hs</div>` : ""}</td>
    <td>${esc(it.tipo)}</td>
    <td>${esc(it.detalle || "—")}</td>
    <td class="num ${it.efecto >= 0 ? "pos" : "neg"}">${it.efecto >= 0 ? "+" : ""}${money(it.efecto)}</td>
    <td>${it.id ? `<button type="button" class="btn-danger btn-sm" data-del-mov="${it.id}" title="Borrar movimiento">🗑️</button>` : ""}</td>
  </tr>`;
  }).join("");

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
//   TRANSFERENCIAS (cajero ↔ cuenta, con comisión)
// ============================================================
// cuentaFija opcional: precarga esa cuenta en el selector.
function abrirTransferir(cuentaFija) {
  const cajeros = state.cajeras.filter((c) => !esCuenta(c));
  const cuentas = state.cajeras.filter((c) => esCuenta(c));
  if (!cajeros.length || !cuentas.length) {
    alert("Necesitás al menos un cajero y una cuenta. Creá una cuenta en Configuración marcando “Es cuenta”.");
    return;
  }
  const cp = comisionCuentaPct();
  const cajeroOpts = cajeros.map((x) => `<option value="${x.id}">${esc(x.nombre)}</option>`).join("");
  const cuentaOpts = cuentas.map((x) => `<option value="${x.id}" ${cuentaFija && x.id === cuentaFija.id ? "selected" : ""}>${esc(x.nombre)}</option>`).join("");

  const dlg = document.createElement("dialog");
  dlg.innerHTML = `
    <form method="dialog" id="form-transf">
      <div class="modal-head">
        <h2 style="margin:0">🔁 Transferir</h2>
        <button type="button" class="btn-ghost btn-sm" id="t-cerrar">✕</button>
      </div>
      <div class="modal-body">
        <div class="grid grid-2">
          <div><label>Sentido</label>
            <select name="dir">
              <option value="cajero_a_cuenta">Cajero → Cuenta</option>
              <option value="cuenta_a_cajero">Cuenta → Cajero</option>
            </select>
          </div>
          <div><label>Monto a transferir</label><input type="number" step="any" name="monto" placeholder="100000" required autofocus /></div>
          <div><label>Cajero</label><select name="cajero_id">${cajeroOpts}</select></div>
          <div><label>Cuenta</label><select name="cuenta_id">${cuentaOpts}</select></div>
        </div>
        <div style="margin-top:12px"><label>Nota (opcional)</label><input name="nota" placeholder="Transferencia" /></div>
        <div id="t-resumen" class="resolver-totales" style="margin-top:14px"></div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn-ghost" id="t-cancelar">Cancelar</button>
        <button type="submit" class="btn-primary">Transferir</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const f = $("#form-transf", dlg);
  const cerrar = () => { dlg.close(); dlg.remove(); };
  $("#t-cerrar", dlg).addEventListener("click", cerrar);
  $("#t-cancelar", dlg).addEventListener("click", cerrar);

  // Devuelve { origen, destino } según el sentido elegido.
  const partes = () => {
    const cajero = cajeros.find((x) => x.id === f.cajero_id.value);
    const cuenta = cuentas.find((x) => x.id === f.cuenta_id.value);
    return f.dir.value === "cuenta_a_cajero"
      ? { origen: cuenta, destino: cajero }
      : { origen: cajero, destino: cuenta };
  };
  // Bono de depósito del casino del cajero destino (cuando el dinero ENTRA a un cajero).
  const bonoPctDestino = (destino) => (!esCuenta(destino) ? num((casaDeCajera(destino) || {}).bono_pct) : 0);
  const refrescar = () => {
    const { origen, destino } = partes();
    const monto = num(f.monto.value);
    // La comisión se cobra SOLO cuando el dinero entra a una cuenta (cajero → cuenta).
    const cobraComision = esCuenta(destino);
    const comision = cobraComision ? monto * cp / 100 : 0;
    // Bono de depósito: solo cuando el destino es un cajero con casino que da bono.
    const bpDest = bonoPctDestino(destino);
    const bonoDest = monto * bpDest / 100;
    const neto = monto - comision + bonoDest;
    const saldoOrigen = origen ? resumenCajera(origen).saldo : 0;
    const insuf = monto > saldoOrigen;
    $("#t-resumen", dlg).innerHTML = `
      <div class="rt-row"><span>De <b>${esc(origen ? origen.nombre : "—")}</b></span><b class="neg">−${money(monto)}</b></div>
      ${cobraComision
        ? `<div class="rt-row"><span>Comisión (${cp}%)</span><b class="neg">−${money(comision)}</b></div>`
        : `<div class="rt-row"><span>Comisión</span><b class="muted">sin comisión (cuenta → cajero)</b></div>`}
      ${bonoDest > 0 ? `<div class="rt-row"><span>Bono depósito (${bpDest}%)</span><b class="pos">+${money(bonoDest)}</b></div>` : ""}
      <div class="rt-row"><span>Recibe <b>${esc(destino ? destino.nombre : "—")}</b></span><b class="pos">+${money(neto)}</b></div>
      <div class="rt-total"><span>Saldo ${esc(origen ? origen.nombre : "")} luego</span><b class="${saldoOrigen - monto >= 0 ? "pos" : "neg"}">${money(Math.max(0, saldoOrigen - monto))}</b></div>
      ${insuf ? `<p class="muted" style="margin:8px 0 0;font-size:12px;color:var(--warn)">⚠️ El saldo de ${esc(origen ? origen.nombre : "")} (${money(saldoOrigen)}) es menor al monto.</p>` : ""}`;
  };
  ["change", "input"].forEach((ev) => f.addEventListener(ev, refrescar));
  refrescar();

  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const { origen, destino } = partes();
    if (!origen || !destino) { alert("Elegí cajero y cuenta."); return; }
    const monto = num(f.monto.value);
    // Comisión solo cuando entra a una cuenta (cajero → cuenta).
    const cobraComision = esCuenta(destino);
    const comision = cobraComision ? monto * cp / 100 : 0;
    // Bono de depósito solo cuando entra a un cajero con casino (cuenta → cajero).
    const bpDest = bonoPctDestino(destino);
    const bonoDest = monto * bpDest / 100;
    const payload = {
      origen_id: origen.id,
      destino_id: destino.id,
      origen_nombre: origen.nombre,
      destino_nombre: destino.nombre,
      monto,
      comision_pct: cobraComision ? cp : 0,
      comision,
      bono_pct_destino: bpDest,
      bono_destino: bonoDest,
      nota: f.nota.value.trim() || null,
    };
    if (guardarTransferencia(payload)) cerrar();
  });
}

// Persiste una transferencia con actualización OPTIMISTA (como guardarMovimiento).
function guardarTransferencia(payload) {
  if (!sb) { alert("Primero configurá Supabase en config.js"); return false; }
  if (!(num(payload.monto) > 0)) { alert("Ingresá un monto mayor a 0."); return false; }
  if (payload.origen_id === payload.destino_id) { alert("El origen y el destino no pueden ser el mismo."); return false; }

  const tempId = "tmp-" + (++_tmpSeq);
  state.transferencias.unshift({ ...payload, id: tempId, creado_en: new Date().toISOString() });
  render();

  setBusy(true);
  sb.from("transferencias").insert(payload).select().single()
    .then(({ data, error }) => {
      const i = state.transferencias.findIndex((t) => t.id === tempId);
      if (error) {
        if (i >= 0) state.transferencias.splice(i, 1); // revierte
        mostrarError("No se pudo guardar la transferencia: " + error.message);
      } else if (i >= 0) {
        state.transferencias[i] = data;
      }
      render();
    })
    .finally(() => setBusy(false));
  return true;
}

// Historial de transferencias (con su comisión). Separado del de retiros.
function abrirTransferencias() {
  const rows = state.transferencias.map((t) => {
    const fh = fmtFechaHoraPartes(t.creado_en);
    return `<tr>
      <td><div>${esc(fh.fecha)}</div>${fh.hora ? `<div class="muted" style="font-size:12px">${esc(fh.hora)} hs</div>` : ""}</td>
      <td>${esc(t.origen_nombre || "—")} → ${esc(t.destino_nombre || "—")}${t.nota ? ` <span class="muted">· ${esc(t.nota)}</span>` : ""}</td>
      <td class="num">${money(num(t.monto))}</td>
      <td class="num neg">${num(t.comision) > 0 ? `−${money(num(t.comision))}` : "—"}</td>
      <td class="num pos">${num(t.bono_destino) > 0 ? `+${money(num(t.bono_destino))}` : "—"}</td>
      <td class="num pos">${money(num(t.monto) - num(t.comision) + num(t.bono_destino))}</td>
      <td><button type="button" class="btn-danger btn-sm" data-del-transf="${t.id}" title="Borrar">🗑️</button></td>
    </tr>`;
  }).join("");
  const totalComision = state.transferencias.reduce((s, t) => s + num(t.comision), 0);

  const dlg = document.createElement("dialog");
  dlg.innerHTML = `
    <form method="dialog" id="form-transf-hist">
      <div class="modal-head">
        <h2 style="margin:0">🔁 Transferencias</h2>
        <button type="button" class="btn-ghost btn-sm" id="th-cerrar">✕</button>
      </div>
      <div class="modal-body">
        <div class="tbl-wrap"><table>
          <thead><tr><th>Fecha</th><th>De → A</th><th class="num">Monto</th><th class="num">Comisión</th><th class="num">Bono</th><th class="num">Neto</th><th></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="7" class="muted">Sin transferencias.</td></tr>`}</tbody>
        </table></div>
        <p class="muted" style="margin:10px 0 0">Comisión total (todas): <b class="neg">−${money(totalComision)}</b>. Se descuenta del profit. Borrar una revierte el saldo y la comisión.</p>
      </div>
      <div class="modal-foot">
        <button type="submit" class="btn-primary">Cerrar</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  const cerrar = () => { dlg.close(); dlg.remove(); };
  $("#th-cerrar", dlg).addEventListener("click", cerrar);
  $("#form-transf-hist", dlg).addEventListener("submit", (e) => { e.preventDefault(); cerrar(); });
  $$("[data-del-transf]", dlg).forEach((b) => b.addEventListener("click", () => borrarTransferencia(b.dataset.delTransf, dlg)));
}

async function borrarTransferencia(id, dlg) {
  if (!confirm("¿Borrar esta transferencia? El saldo y la comisión se revierten.")) return;
  const backup = [...state.transferencias];
  state.transferencias = state.transferencias.filter((t) => t.id !== id);
  render();
  dlg.close(); dlg.remove();
  abrirTransferencias(); // reabrir ya sin la fila

  setBusy(true);
  const { error } = await sb.from("transferencias").delete().eq("id", id);
  setBusy(false);
  if (error) {
    state.transferencias = backup; // revierte
    render();
    mostrarError("No se pudo borrar la transferencia: " + error.message);
  }
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

// Opciones de admin (dueño) para asignar a una cajera/cuenta.
function opcionesAdmin(selId) {
  return `<option value="">— sin admin —</option>` +
    state.admins.map((a) => `<option value="${a.id}" ${a.id === selId ? "selected" : ""}>${esc(a.nombre)}</option>`).join("");
}

function viewConfig() {
  const casas = state.casas.map((c) => `<div class="cajera-cfg">
    <span class="cajera-cfg-nombre">${esc(c.nombre)}<span class="muted">${c.tiene_cajeras ? " · 💰 cajeras" : ""}${c.permite_gratis ? " · 🎁 gratis" : ""}</span></span>
    <label class="muted" style="display:flex;align-items:center;gap:6px;white-space:nowrap">Bono % <input type="number" step="any" data-bono-casa="${c.id}" value="${num(c.bono_pct)}" style="width:80px" /></label>
    <label class="muted" style="display:flex;align-items:center;gap:6px;white-space:nowrap" title="Mostrar este casino en el filtro del panel de Cajeros"><input type="checkbox" data-filtro-casa="${c.id}" ${c.mostrar_filtro ? "checked" : ""} style="width:auto" /> 🔎 filtro</label>
    <button class="btn-danger btn-sm" data-del-casa="${c.id}" title="Borrar">✕</button>
  </div>`).join("");
  const cajeras = state.cajeras.map((c) => `<div class="cajera-cfg">
    <span class="cajera-cfg-nombre">${esc(c.nombre)}</span>
    ${esCuenta(c) ? `<span class="muted">sin casino</span>` : `<select data-casa-cajera="${c.id}">${opcionesCasaCajera(c.casa_id)}</select>`}
    <label class="muted" style="display:flex;align-items:center;gap:6px;white-space:nowrap" title="Marcar como cuenta (persona, no apuesta)"><input type="checkbox" data-cuenta-cajera="${c.id}" ${esCuenta(c) ? "checked" : ""} style="width:auto" /> 👤 cuenta</label>
    <select data-admin-cajera="${c.id}" title="Admin">${opcionesAdmin(c.admin_id)}</select>
    <button class="btn-danger btn-sm" data-del-cajera="${c.id}" title="Borrar">✕</button>
  </div>`).join("");
  const admins = state.admins.map((a) => `<div class="cajera-cfg">
    <span class="cajera-cfg-nombre">${esc(a.nombre)}</span>
    <button class="btn-danger btn-sm" data-del-admin="${a.id}" title="Borrar">✕</button>
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
        <label style="display:flex;align-items:center;gap:6px;color:var(--text);cursor:pointer;white-space:nowrap">
          <input type="checkbox" id="casa-filtro" style="width:auto" /> 🔎 Mostrar en filtro
        </label>
        <button class="btn-primary" id="add-casa">Agregar casa</button>
      </div>
    </div>
    <div class="card">
      <h2>Cajeras y cuentas</h2>
      <div style="margin-bottom:14px">${cajeras || `<span class="muted">Sin cajeras</span>`}</div>
      <div class="row">
        <div class="field"><label>Nombre</label><input id="cajera-nombre" placeholder="Ej. Julieta Principal Daalber" /></div>
        <div class="field"><label>Casino</label><select id="cajera-casa">${opcionesCasaCajera(null)}</select></div>
        <label style="display:flex;align-items:center;gap:6px;color:var(--text);cursor:pointer;white-space:nowrap">
          <input type="checkbox" id="cajera-es-cuenta" style="width:auto" /> 👤 Es cuenta (persona, no apuesta)
        </label>
        <button class="btn-primary" id="add-cajera">Agregar</button>
      </div>
      <p class="muted" style="margin:8px 0 0">Una <b>cuenta</b> es una persona a la que le transferís plata (no se apuesta con ella, no se asocia a casino).</p>
    </div>
    <div class="card">
      <h2>Admins</h2>
      <div style="margin-bottom:14px">${admins || `<span class="muted">Sin admins</span>`}</div>
      <div class="row">
        <div class="field"><label>Nombre</label><input id="admin-nombre" placeholder="Ej. Daniel" /></div>
        <button class="btn-primary" id="add-admin">Agregar admin</button>
      </div>
      <p class="muted" style="margin:8px 0 0">Un <b>admin</b> es el dueño de ciertos cajeros/cuentas. Asignalos en la lista de arriba y filtralos en el panel de Cajeras.</p>
    </div>
    <div class="card">
      <h2>Ajustes</h2>
      <div class="row">
        <div class="field"><label>Comisión de cuentas (%)</label><input id="comision-pct" type="number" step="any" value="${comisionCuentaPct()}" style="max-width:140px" /></div>
      </div>
      <p class="muted" style="margin:8px 0 0">Se cobra en cada transferencia entre cajero y cuenta y se descuenta del profit.</p>
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
      mostrar_filtro: $("#casa-filtro").checked,
    });
    if (error) { alert("Error: " + error.message); return; }
    await cargarTodo(); render();
  });
  $$("[data-filtro-casa]").forEach((cb) => cb.addEventListener("change", async () => {
    const { error } = await sb.from("casas").update({ mostrar_filtro: cb.checked }).eq("id", cb.dataset.filtroCasa);
    if (error) { alert("Error: " + error.message); return; }
    await cargarTodo(); render();
  }));
  $("#add-cajera")?.addEventListener("click", async () => {
    const nombre = $("#cajera-nombre").value.trim();
    if (!nombre) return;
    const esCta = $("#cajera-es-cuenta")?.checked;
    const { error } = await sb.from("cajeras").insert({
      nombre,
      es_cuenta: !!esCta,
      casa_id: esCta ? null : ($("#cajera-casa").value || null),
    });
    if (error) { alert("Error: " + error.message); return; }
    await cargarTodo(); render();
  });
  $("#comision-pct")?.addEventListener("change", async (e) => {
    const { error } = await sb.from("config")
      .upsert({ clave: "comision_cuenta_pct", valor: String(num(e.target.value)) });
    if (error) { alert("Error: " + error.message); return; }
    await cargarTodo(); render();
  });
  $("#add-admin")?.addEventListener("click", async () => {
    const nombre = $("#admin-nombre").value.trim();
    if (!nombre) return;
    const { error } = await sb.from("admins").insert({ nombre });
    if (error) { alert("Error: " + error.message); return; }
    await cargarTodo(); render();
  });
  $$("[data-admin-cajera]").forEach((sel) => sel.addEventListener("change", async () => {
    const { error } = await sb.from("cajeras").update({ admin_id: sel.value || null }).eq("id", sel.dataset.adminCajera);
    if (error) { alert("Error: " + error.message); return; }
    await cargarTodo(); render();
  }));
  $$("[data-cuenta-cajera]").forEach((cb) => cb.addEventListener("change", async () => {
    // Marcar/desmarcar como cuenta. Si pasa a cuenta, se le saca el casino.
    const upd = cb.checked ? { es_cuenta: true, casa_id: null } : { es_cuenta: false };
    const { error } = await sb.from("cajeras").update(upd).eq("id", cb.dataset.cuentaCajera);
    if (error) { alert("Error: " + error.message); return; }
    await cargarTodo(); render();
  }));
  $$("[data-del-admin]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("¿Borrar admin? Los cajeros/cuentas quedan sin admin.")) return;
    await sb.from("admins").delete().eq("id", b.dataset.delAdmin);
    await cargarTodo(); render();
  }));
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
$$("[data-tab]").forEach((t) => t.addEventListener("click", () => { state.tab = t.dataset.tab; render(); }));

// Refresh manual: re-baja todos los datos del servidor y re-renderiza.
$("#refresh")?.addEventListener("click", async () => {
  if (!sb) return;
  const btn = $("#refresh");
  if (btn.classList.contains("spinning")) return; // evita dobles
  btn.classList.add("spinning");
  try { await cargarTodo(); render(); }
  finally { btn.classList.remove("spinning"); }
});

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

// Mantiene fresco el "Hace X" de la última actualización sin re-renderizar todo.
setInterval(actualizarUltimaAct, 60000);
