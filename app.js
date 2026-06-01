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
  tab: "reportes",
  casas: [],     // {id, nombre, bono_pct}
  cajeras: [],   // {id, nombre}
  apuestas: [],  // {..., lineas:[...]}
  pagina: 1,         // paginado del listado de apuestas
  filtroEstado: "",  // chip de estado en la pestaña Apuestas ("" = todas)
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

// Aplica los filtros de la pestaña Reportes
function apuestasFiltradas() {
  const f = state.filtroRep;
  let desde = null, hasta = null;
  if (f.periodo === "semana") desde = hoyMenosDias(7);
  else if (f.periodo === "mes") desde = hoyMenosDias(30);
  else if (f.periodo === "custom") { desde = f.desde || null; hasta = f.hasta || null; }

  return state.apuestas.filter((a) => {
    if (desde && (!a.fecha || a.fecha < desde)) return false;
    if (hasta && (!a.fecha || a.fecha > hasta)) return false;
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
  const apostado = cargado * (1 + num(l.bono_pct) / 100);
  const cuota = num(l.cuota);
  const gratis = num(l.apuesta_gratis); // apuesta gratis: NO es dinero ingresado
  // pago normal + pago de la apuesta gratis (la casa retiene el monto: gratis × (cuota − 1))
  const premio = apostado * cuota + (cuota > 0 ? gratis * (cuota - 1) : 0);
  return { cargado, apostado, premio, gratis };
}

function calcApuesta(a) {
  const lineas = a.lineas || [];
  let ingresado = 0, apostado = 0;
  lineas.forEach((l) => { const c = calcLinea(l); ingresado += c.cargado; apostado += c.apostado; });

  let premioGanador = 0;
  if (a.resultado_ganador) {
    lineas.filter((l) => (l.resultado || "") === a.resultado_ganador)
          .forEach((l) => { premioGanador += calcLinea(l).premio; });
  }
  const premio = (a.premio_cobrado != null && a.premio_cobrado !== "")
    ? num(a.premio_cobrado) : premioGanador;

  let profit = null;
  if (a.estado === "Cobrado") profit = premio - ingresado;
  else if (a.estado === "Perdido") profit = -ingresado;

  const pctv = profit != null && ingresado > 0 ? (profit / ingresado) * 100 : null;
  return { ingresado, apostado, premioGanador, premio, profit, pct: pctv };
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

// ---------- Carga de datos ----------
async function cargarTodo() {
  if (!sb) return;
  const [casas, cajeras, apuestas, lineas] = await Promise.all([
    sb.from("casas").select("*").order("nombre"),
    sb.from("cajeras").select("*").order("nombre"),
    sb.from("apuestas").select("*").order("fecha", { ascending: false, nullsFirst: false }).order("creado_en", { ascending: false }),
    sb.from("lineas").select("*").order("orden"),
  ]);
  for (const r of [casas, cajeras, apuestas, lineas]) {
    if (r.error) { mostrarError(r.error.message); return; }
  }
  state.casas = casas.data;
  state.cajeras = cajeras.data;
  const porApuesta = {};
  lineas.data.forEach((l) => { (porApuesta[l.apuesta_id] ||= []).push(l); });
  state.apuestas = apuestas.data.map((a) => ({ ...a, lineas: porApuesta[a.id] || [] }));
}

function mostrarError(msg) {
  $("#banner").innerHTML = `<div class="banner" style="border-color:var(--danger);background:#3a1414;color:#f8a9a4;">⚠️ ${esc(msg)}</div>`;
}

// ============================================================
//   RENDER PRINCIPAL
// ============================================================
function render() {
  // banner de config
  if (!CONFIGURADO) {
    $("#banner").innerHTML = `<div class="banner">⚙️ Falta conectar la base de datos. Abrí <b>config.js</b> y pegá tu URL y anon key de Supabase. Mirá <b>README.md</b> para los pasos.</div>`;
  }
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === state.tab));
  const v = $("#view");
  if (state.tab === "reportes") { v.innerHTML = viewReportes(); bindReportes(); }
  else if (state.tab === "apuestas") { v.innerHTML = viewApuestas(); bindApuestas(); }
  else if (state.tab === "config") { v.innerHTML = viewConfig(); bindConfig(); }
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
  const transferencia = calc.filter((x) => x.a.estado === "Cobrado").reduce((s, x) => s + x.c.premio, 0);
  const ingresadoTotal = calc.reduce((s, x) => s + x.c.ingresado, 0);
  const pctProm = resueltas.length
    ? resueltas.reduce((s, x) => s + (x.c.pct || 0), 0) / resueltas.length : null;

  const porMes = {};
  resueltas.forEach((x) => {
    const k = x.a.fecha ? x.a.fecha.slice(0, 7) : "sin fecha";
    (porMes[k] ||= { profit: 0, n: 0 }); porMes[k].profit += x.c.profit; porMes[k].n++;
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

  const sinDatos = lista.length === 0;
  $("#rep-results").innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="label">Profit total</div><div class="value ${profitTotal >= 0 ? "pos" : "neg"}">${money(profitTotal)}</div></div>
      <div class="kpi"><div class="label">Transferencia recibido</div><div class="value pos">${money(transferencia)}</div></div>
      <div class="kpi"><div class="label">Total ingresado</div><div class="value">${money(ingresadoTotal)}</div></div>
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

// ============================================================
//   VISTA: APUESTAS
// ============================================================
function viewApuestas() {
  // conteo por estado (sobre todas las apuestas) para los chips
  const cont = { "": state.apuestas.length, Pendiente: 0, Cobrado: 0, Perdido: 0 };
  state.apuestas.forEach((a) => { cont[a.estado] = (cont[a.estado] || 0) + 1; });

  const lista = state.filtroEstado
    ? state.apuestas.filter((a) => a.estado === state.filtroEstado)
    : state.apuestas;

  const total = lista.length;
  const paginas = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (state.pagina > paginas) state.pagina = paginas;
  if (state.pagina < 1) state.pagina = 1;
  const inicio = (state.pagina - 1) * PAGE_SIZE;
  const visibles = lista.slice(inicio, inicio + PAGE_SIZE);

  const chips = [["", "Todas"], ["Pendiente", "Pendientes"], ["Cobrado", "Cobradas"], ["Perdido", "Perdidas"]]
    .map(([v, t]) => `<button class="chip-f ${state.filtroEstado === v ? "active" : ""}" data-estado="${v}">${t} <span class="chip-n">${cont[v] || 0}</span></button>`)
    .join("");

  const filas = visibles.map((a) => {
    const c = calcApuesta(a);
    // Pendiente → desglose potencial por casa (premio / profit / %); resuelto → valores reales
    const pend = a.estado === "Pendiente";
    const pot = pend ? potencialPorCasa(a) : [];
    const premioCell = pend ? potListHtml(pot, "premio") : money(c.premio);
    const profitCell = pend ? potListHtml(pot, "profit") : (c.profit == null ? "—" : money(c.profit));
    const pctCell = pend ? potListHtml(pot, "pct") : pct(c.pct);
    return `<tr>
      <td data-label="Partido">${esc(a.partido)}</td>
      <td data-label="Fecha">${esc(a.fecha || "")}${a.hora ? " · " + esc(fmtHora(a.hora)) : ""}</td>
      <td data-label="Cajera">${esc(a.cajera || "")}</td>
      <td data-label="Estado"><span class="badge ${esc(a.estado)}">${esc(a.estado)}</span></td>
      <td class="num" data-label="Ingresado">${money(c.ingresado)}</td>
      <td class="num" data-label="${pend ? "Premio potencial" : "Premio"}">${premioCell}</td>
      <td class="num ${pend || c.profit == null ? "" : c.profit >= 0 ? "pos" : "neg"}" data-label="${pend ? "Profit potencial" : "Profit"}">${profitCell}</td>
      <td class="num ${pend || c.pct == null ? "" : c.pct >= 0 ? "pos" : "neg"}" data-label="${pend ? "% potencial" : "%"}">${pctCell}</td>
      <td data-label="">
        <div class="acciones">
          <div class="acc-left">
            <button class="btn-danger btn-sm" data-del="${a.id}" title="Eliminar">🗑️</button>
            <button class="btn-ghost btn-sm" data-edit="${a.id}">✏️ Editar</button>
          </div>
          <div class="acc-right">
            ${pend ? `<button class="btn-primary btn-sm" data-resolver="${a.id}">✅ Resolver</button>` : ""}
            <button class="btn-ghost btn-sm" data-detalle="${a.id}">👁️ Detalle</button>
          </div>
        </div>
      </td>
    </tr>`;
  }).join("");

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
      <button class="btn-primary" id="nueva">+ Nueva apuesta</button>
      <div class="spacer"></div>
      <span class="muted">${total ? `${desde}–${hasta} de ${total}` : "0"} apuesta(s)</span>
    </div>
    <div class="chips-filtro">${chips}</div>
    <div class="card tbl-wrap">
      <table class="apuestas-tbl">
        <thead><tr>
          <th>Partido</th><th>Fecha</th><th>Cajera</th><th>Estado</th>
          <th class="num">Ingresado</th><th class="num">Premio</th><th class="num">Profit</th><th class="num">%</th><th></th>
        </tr></thead>
        <tbody>${filas || `<tr><td colspan="9" class="muted">Sin apuestas todavía.</td></tr>`}</tbody>
      </table>
    </div>
    ${pager}
  `;
}

function bindApuestas() {
  $("#nueva")?.addEventListener("click", () => abrirModal(null));
  $$("[data-edit]").forEach((b) => b.addEventListener("click", () =>
    abrirModal(state.apuestas.find((a) => a.id === b.dataset.edit))));
  $$("[data-resolver]").forEach((b) => b.addEventListener("click", () =>
    abrirResolver(state.apuestas.find((a) => a.id === b.dataset.resolver))));
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
//   MODAL: Nueva / Editar apuesta
// ============================================================
let modalLineas = []; // working copy mientras el modal está abierto

function bonoDeCasa(nombre) {
  const c = state.casas.find((x) => x.nombre === nombre);
  return c ? c.bono_pct : 0;
}

function casaPermiteGratis(nombre) {
  const c = state.casas.find((x) => x.nombre === nombre);
  return !!(c && c.permite_gratis);
}

function nuevaLinea(casa = "") {
  return { casa, monto_cargado: "", bono_pct: bonoDeCasa(casa), cuota: "", resultado: "", apuesta_gratis: "" };
}

function abrirModal(apuesta) {
  const editando = !!apuesta;
  const a = apuesta || {
    partido: "", fecha: "", hora: "", cajera: "", estado: "Pendiente",
    resultado_ganador: "", premio_cobrado: "", notas: "",
  };
  // líneas: las existentes, o las casas por defecto
  modalLineas = editando
    ? a.lineas.map((l) => ({ ...l }))
    : (CFG.CASAS_POR_DEFECTO || ["Vira", "Betano"]).map((n) => nuevaLinea(n));

  const dlg = document.createElement("dialog");
  dlg.innerHTML = `
    <form method="dialog" id="form-apuesta">
      <div class="modal-head">
        <h2 style="margin:0">${editando ? "Editar" : "Nueva"} apuesta</h2>
        <button type="button" class="btn-ghost btn-sm" id="cerrar">✕</button>
      </div>
      <div class="modal-body">
        <div class="grid grid-2">
          <div><label>Partido / Evento</label><input name="partido" value="${esc(a.partido)}" required placeholder="PSG vs Arsenal" /></div>
          <div><label>Cajera</label>${selectCajera(a.cajera)}</div>
          <div><label>Fecha</label><input type="date" name="fecha" value="${esc(a.fecha || "")}" /></div>
          <div><label>Hora</label><input name="hora" value="${esc(a.hora || "")}" placeholder="13 hs" /></div>
        </div>

        <h2 style="margin:18px 0 8px">Casas</h2>
        <div id="lineas"></div>
        <button type="button" class="btn-ghost btn-sm" id="add-linea">+ Agregar casa</button>

        <h2 style="margin:18px 0 8px">Resolución</h2>
        <div class="grid grid-3">
          <div><label>Estado</label>
            <select name="estado">
              ${["Pendiente", "Cobrado", "Perdido"].map((e) => `<option ${a.estado === e ? "selected" : ""}>${e}</option>`).join("")}
            </select>
          </div>
          <div><label>Resultado ganador</label><div id="ganador-wrap"></div></div>
          <div><label>Premio cobrado (editable)</label><input type="number" step="any" name="premio_cobrado" value="${a.premio_cobrado ?? ""}" placeholder="auto desde la cuota" /></div>
        </div>
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
  $("[name=estado]", dlg).addEventListener("change", () => actualizarResumen(dlg));
  $("[name=premio_cobrado]", dlg).addEventListener("input", () => actualizarResumen(dlg));

  renderLineas(dlg);
  renderGanador(dlg, a.resultado_ganador);

  $("#form-apuesta", dlg).addEventListener("submit", (e) => {
    e.preventDefault();
    guardarApuesta(dlg, editando ? a.id : null).then((ok) => { if (ok) { cerrar(); } });
  });
}

function selectCajera(sel) {
  const opts = state.cajeras.map((c) => `<option ${c.nombre === sel ? "selected" : ""}>${esc(c.nombre)}</option>`).join("");
  return `<select name="cajera"><option value="">— elegir —</option>${opts}</select>`;
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
      <div><label>Bono %</label><input type="number" step="any" data-f="bono_pct" value="${l.bono_pct}" /></div>
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
        // al cambiar la casa: autocompletar bono y re-render (para mostrar/ocultar "Apuesta gratis")
        modalLineas[i].bono_pct = bonoDeCasa(inp.value);
        if (!casaPermiteGratis(inp.value)) modalLineas[i].apuesta_gratis = "";
        renderLineas(dlg);
        renderGanador(dlg, $("[name=resultado_ganador]", dlg)?.value);
        actualizarResumen(dlg);
        return;
      }
      // actualizar solo el texto del cálculo de esta línea (no re-render → no se pierde el foco)
      const c = calcLinea(modalLineas[i]);
      const txt = $(".calc-txt", row);
      if (txt) txt.innerHTML = `apostado<b>${money(c.apostado)}</b>premio ${money(c.premio)}`;
      if (f === "resultado") renderGanador(dlg, $("[name=resultado_ganador]", dlg)?.value);
      actualizarResumen(dlg);
    });
  });
  // botones de borrar línea (se rebindea entero en cada render completo)
  $$("[data-rm]", cont).forEach((b) => b.addEventListener("click", () => {
    modalLineas.splice(+b.dataset.rm, 1);
    renderLineas(dlg);
    renderGanador(dlg, $("[name=resultado_ganador]", dlg)?.value);
  }));
  actualizarResumen(dlg);
}

function renderGanador(dlg, sel) {
  const resultados = [...new Set(modalLineas.map((l) => (l.resultado || "").trim()).filter(Boolean))];
  const opts = resultados.map((r) => `<option ${r === sel ? "selected" : ""}>${esc(r)}</option>`).join("");
  $("#ganador-wrap", dlg).innerHTML =
    `<select name="resultado_ganador"><option value="">— ninguno —</option>${opts}</select>`;
  $("[name=resultado_ganador]", dlg).addEventListener("change", () => actualizarResumen(dlg));
}

function actualizarResumen(dlg) {
  const fake = {
    estado: $("[name=estado]", dlg).value,
    resultado_ganador: $("[name=resultado_ganador]", dlg)?.value || "",
    premio_cobrado: $("[name=premio_cobrado]", dlg).value,
    lineas: modalLineas,
  };
  const c = calcApuesta(fake);
  const premioAuto = c.premioGanador;
  const totalGratis = modalLineas.reduce((s, l) => s + num(l.apuesta_gratis), 0);
  $("#resumen", dlg).innerHTML =
    `Ingresado: <b>${money(c.ingresado)}</b> · Apostado: <b>${money(c.apostado)}</b>` +
    (totalGratis > 0 ? ` · 🎁 Apuesta gratis: <b>${money(totalGratis)}</b>` : "") +
    ` · Premio línea ganadora: <b>${money(premioAuto)}</b>` +
    (c.profit != null ? ` · Profit: <b class="${c.profit >= 0 ? "pos" : "neg"}">${money(c.profit)}</b> (${pct(c.pct)})` : "");
}

// ============================================================
//   PERSISTENCIA
// ============================================================
async function guardarApuesta(dlg, id) {
  if (!sb) { alert("Primero configurá Supabase en config.js"); return false; }
  const f = $("#form-apuesta", dlg);
  const payload = {
    partido: f.partido.value.trim(),
    fecha: f.fecha.value || null,
    hora: f.hora.value.trim() || null,
    cajera: f.cajera.value || null,
    estado: f.estado.value,
    resultado_ganador: f.resultado_ganador?.value || null,
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
      bono_pct: num(l.bono_pct),
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
//   POPUP: Ver detalle (solo lectura)
// ============================================================
function abrirDetalle(a) {
  if (!a) return;
  const c = calcApuesta(a);
  const lineasRows = (a.lineas || []).map((l) => {
    const lc = calcLinea(l);
    return `<tr>
      <td>${esc(l.casa || "—")}</td>
      <td class="num">${money(num(l.monto_cargado))}</td>
      <td class="num">${num(l.bono_pct)}%</td>
      <td class="num">${num(l.apuesta_gratis) > 0 ? money(num(l.apuesta_gratis)) : "—"}</td>
      <td class="num">${l.cuota == null || l.cuota === "" ? "—" : num(l.cuota)}</td>
      <td>${esc(l.resultado || "—")}</td>
      <td class="num">${money(lc.apostado)}</td>
      <td class="num">${money(lc.premio)}</td>
    </tr>`;
  }).join("");

  const dlg = document.createElement("dialog");
  dlg.innerHTML = `
    <form method="dialog" id="form-detalle">
      <div class="modal-head">
        <h2 style="margin:0">${esc(a.partido)} <span class="badge ${esc(a.estado)}" style="margin-left:8px">${esc(a.estado)}</span></h2>
        <button type="button" class="btn-ghost btn-sm" id="d-cerrar">✕</button>
      </div>
      <div class="modal-body">
        <div class="detalle-grid">
          <div><label>Fecha</label><div class="ro">${esc(a.fecha || "—")}</div></div>
          <div><label>Hora</label><div class="ro">${a.hora ? esc(fmtHora(a.hora)) : "—"}</div></div>
          <div><label>Cajera</label><div class="ro">${esc(a.cajera || "—")}</div></div>
          <div><label>Resultado ganador</label><div class="ro">${esc(a.resultado_ganador || "—")}</div></div>
        </div>
        ${a.notas ? `<div style="margin-top:12px"><label>Notas</label><div class="ro">${esc(a.notas)}</div></div>` : ""}

        <h2 style="margin:18px 0 8px">Casas</h2>
        <div class="tbl-wrap"><table>
          <thead><tr>
            <th>Casa</th><th class="num">Cargado</th><th class="num">Bono</th><th class="num">🎁 Gratis</th>
            <th class="num">Cuota</th><th>Resultado</th><th class="num">Apostado</th><th class="num">Premio</th>
          </tr></thead>
          <tbody>${lineasRows || `<tr><td colspan="8" class="muted">Sin casas</td></tr>`}</tbody>
        </table></div>

        <div class="kpis" style="margin-top:16px">
          <div class="kpi"><div class="label">Ingresado</div><div class="value" style="font-size:18px">${money(c.ingresado)}</div></div>
          <div class="kpi"><div class="label">Apostado</div><div class="value" style="font-size:18px">${money(c.apostado)}</div></div>
          <div class="kpi"><div class="label">Premio</div><div class="value" style="font-size:18px">${a.estado === "Pendiente" ? "—" : money(c.premio)}</div></div>
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
//   POPUP: Resolver apuesta (solo datos de resolución)
// ============================================================
function abrirResolver(a) {
  if (!a) return;
  const resultados = [...new Set((a.lineas || []).map((l) => (l.resultado || "").trim()).filter(Boolean))];
  const dlg = document.createElement("dialog");
  dlg.innerHTML = `
    <form method="dialog" id="form-resolver">
      <div class="modal-head">
        <h2 style="margin:0">Resolver — ${esc(a.partido)}</h2>
        <button type="button" class="btn-ghost btn-sm" id="r-cerrar">✕</button>
      </div>
      <div class="modal-body">
        <div class="grid grid-3">
          <div><label>Estado</label>
            <select name="estado">
              ${["Pendiente", "Cobrado", "Perdido"].map((e) => `<option ${a.estado === e ? "selected" : ""}>${e}</option>`).join("")}
            </select>
          </div>
          <div><label>Resultado ganador</label>
            <select name="resultado_ganador">
              <option value="">— ninguno —</option>
              ${resultados.map((r) => `<option ${a.resultado_ganador === r ? "selected" : ""}>${esc(r)}</option>`).join("")}
            </select>
          </div>
          <div><label>Premio cobrado (editable)</label>
            <input type="number" step="any" name="premio_cobrado" value="${a.premio_cobrado ?? ""}" placeholder="auto desde la cuota" />
          </div>
        </div>
        <div id="r-resumen" class="muted" style="margin-top:12px"></div>
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

  const refrescar = (autoPremio) => {
    // si se cambió el resultado ganador, autocompletar el premio cobrado con el de la línea ganadora
    if (autoPremio) {
      const ganador = f.resultado_ganador.value;
      const premioGanador = ganador
        ? (a.lineas || []).filter((l) => (l.resultado || "") === ganador)
            .reduce((s, l) => s + calcLinea(l).premio, 0)
        : 0;
      f.premio_cobrado.value = premioGanador ? premioGanador : "";
    }
    const c = calcApuesta({
      estado: f.estado.value,
      resultado_ganador: f.resultado_ganador.value || "",
      premio_cobrado: f.premio_cobrado.value,
      lineas: a.lineas,
    });
    $("#r-resumen", dlg).innerHTML =
      `Ingresado: <b>${money(c.ingresado)}</b> · Premio: <b>${money(c.premio)}</b>` +
      (c.profit != null ? ` · Profit: <b class="${c.profit >= 0 ? "pos" : "neg"}">${money(c.profit)}</b> (${pct(c.pct)})` : "");
  };

  f.estado.addEventListener("change", () => refrescar(false));
  f.resultado_ganador.addEventListener("change", () => refrescar(true));
  f.premio_cobrado.addEventListener("input", () => refrescar(false));
  refrescar(false);

  f.addEventListener("submit", (e) => {
    e.preventDefault();
    guardarResolucion(dlg, a.id).then((ok) => { if (ok) cerrar(); });
  });
}

async function guardarResolucion(dlg, id) {
  if (!sb) { alert("Primero configurá Supabase en config.js"); return false; }
  const f = $("#form-resolver", dlg);
  const payload = {
    estado: f.estado.value,
    resultado_ganador: f.resultado_ganador.value || null,
    premio_cobrado: f.premio_cobrado.value === "" ? null : num(f.premio_cobrado.value),
  };
  const { error } = await sb.from("apuestas").update(payload).eq("id", id);
  if (error) { alert("Error: " + error.message); return false; }
  await cargarTodo();
  render();
  return true;
}

// ============================================================
//   VISTA: CONFIGURACIÓN (casas y cajeras)
// ============================================================
function viewConfig() {
  const casas = state.casas.map((c) => `<div class="chip">${esc(c.nombre)} <span class="muted">· bono ${c.bono_pct}%${c.permite_gratis ? " · 🎁 gratis" : ""}</span>
    <button data-del-casa="${c.id}" title="Borrar">✕</button></div>`).join("");
  const cajeras = state.cajeras.map((c) => `<div class="chip">${esc(c.nombre)}
    <button data-del-cajera="${c.id}" title="Borrar">✕</button></div>`).join("");

  return `
    <div class="card">
      <h2>Casas de apuestas</h2>
      <div class="chip-list" style="margin-bottom:14px">${casas || `<span class="muted">Sin casas</span>`}</div>
      <div class="row">
        <div class="field"><label>Nombre</label><input id="casa-nombre" placeholder="Ej. Vira" /></div>
        <div class="field"><label>Bono %</label><input id="casa-bono" type="number" step="any" value="0" /></div>
        <label style="display:flex;align-items:center;gap:6px;color:var(--text);cursor:pointer;white-space:nowrap">
          <input type="checkbox" id="casa-gratis" style="width:auto" /> 🎁 Da apuesta gratis
        </label>
        <button class="btn-primary" id="add-casa">Agregar casa</button>
      </div>
    </div>
    <div class="card">
      <h2>Cajeras</h2>
      <div class="chip-list" style="margin-bottom:14px">${cajeras || `<span class="muted">Sin cajeras</span>`}</div>
      <div class="row">
        <div class="field"><label>Nombre</label><input id="cajera-nombre" placeholder="Ej. Julieta Principal Daalber" /></div>
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
      permite_gratis: $("#casa-gratis").checked,
    });
    if (error) { alert("Error: " + error.message); return; }
    await cargarTodo(); render();
  });
  $("#add-cajera")?.addEventListener("click", async () => {
    const nombre = $("#cajera-nombre").value.trim();
    if (!nombre) return;
    const { error } = await sb.from("cajeras").insert({ nombre });
    if (error) { alert("Error: " + error.message); return; }
    await cargarTodo(); render();
  });
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

(async function init() {
  render();
  if (sb) { await cargarTodo(); render(); }
})();
