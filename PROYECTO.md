# 📊 Proyecto Apuestas — Documentación

> Documento de referencia con todo lo construido. Sirve para retomar el proyecto en el futuro (incluso tras borrar el chat de Claude).
> Última actualización: 2026-06-05.

---

## 1. Qué es
App web para registrar apuestas y llevar el historial de ganancias, reemplazando un Google Sheet ("Apuests 2"). Permite cargar apuestas con varias casas, calcular profit/% automáticamente y ver reportes. Funciona en **celular y PC** con datos en la nube.

## 2. Stack tecnológico
- **Frontend:** HTML + CSS + JavaScript **vanilla, sin build** (no usa Node/npm porque no están instalados en la PC). Supabase se carga desde CDN.
- **Base de datos:** Supabase (PostgreSQL). API REST automática (PostgREST).
- **Hosting:** Vercel (deploy automático desde GitHub).
- **Repo:** https://github.com/FDany90/bets (privado)
- **Supabase project ref:** `lmwwmeixxibhuiqrovdm` → URL `https://lmwwmeixxibhuiqrovdm.supabase.co`

## 3. Estructura de archivos
| Archivo | Qué es |
|---|---|
| `index.html` | Página principal (tabs Reportes / Partidos / Cajeras / Configuración) |
| `app.js` | Toda la lógica: estado, cálculos, render, modales, CRUD a Supabase |
| `styles.css` | Estilos (tema oscuro, responsive: tabla → tarjetas en mobile) |
| `config.js` | URL + publishable key de Supabase + casas por defecto |
| `supabase-schema.sql` | Esquema completo (para instalar de cero). **Gitignored** (tiene la contraseña en un comentario). |
| `migracion-apuesta-gratis.sql` | Migración que agregó las columnas de apuesta gratis |
| `migracion-partidos.sql` | Migración que creó la tabla `partidos` y la FK `apuestas.partido_id` (agrupa N apuestas por partido) |
| `migracion-cajeras-saldo.sql` | Migración que creó la tabla `movimientos` (billetera por cajera) y `casas.tiene_cajeras` |
| `migracion-bono-por-casa.sql` | Migración que agregó `movimientos.casa` (bono de depósito configurable por casa) |
| `migracion-cajera-casa.sql` | Migración que agregó `cajeras.casa_id` (cada cajera pertenece a un casino) |
| `reset-datos.sql` | Borra partidos/apuestas/líneas/movimientos (empezar de cero), mantiene casas y cajeras |
| `dist/` | Copia de los 4 archivos web para Netlify Drop (gitignored) |
| `README.md` | Pasos de puesta en marcha |
| `.gitignore` | Excluye `*.sql`, `dist/`, etc. (para no publicar secretos) |

> Nota: los `*.sql` están gitignored, así que **no** se suben a la web ni al repo. Son solo para correr en el SQL Editor de Supabase.

## 4. Modelo de datos (tablas Supabase)

**`casas`** — catálogo de casas de apuestas
- `id` uuid · `nombre` text único · `bono_pct` numeric (**bono de depósito por casa**, ej. Vira=20, SuperPro=10; se aplica al cargar dinero, NO en las apuestas) · `tiene_cajeras` boolean (sus líneas descuentan/acreditan el saldo de la cajera, ej. Vira=true) · `permite_gratis` boolean (da "apuesta gratis", ej. Betano=true) · `creado_en`

**`cajeras`** — catálogo de cajeras + billetera (saldo)
- `id` uuid · `nombre` text único · `casa_id` uuid (FK → casas; el casino al que pertenece, define el bono al depositar) · `creado_en`
- El **saldo no se guarda**: se calcula en vivo (ver tabla `movimientos` y sección 5).

**`movimientos`** — cargas y retiros manuales de dinero por cajera
- `id` uuid · `cajera_id` uuid (FK → cajeras, on delete cascade) · `tipo` text ('Carga'|'Retiro') · `monto` numeric (base ingresado, positivo) · `bono_pct` numeric (bono aplicado en la carga; 0 si sin bono/retiro) · `casa` text (en qué casa se cargó, define el bono) · `nota` text · `creado_en`
- Los débitos/créditos por apuestas **no** se guardan acá: se derivan de las apuestas.

**`partidos`** — un partido/evento que agrupa N apuestas
- `id` uuid · `nombre` text · `fecha` date · `hora` text · `resultado_ganador` text (null = Pendiente; con valor = Finalizado) · `creado_en`
- Estado del partido **derivado**: `Pendiente` si `resultado_ganador` es null, `Finalizado` si tiene valor.

**`apuestas`** — una apuesta dentro de un partido (un set de casas/líneas)
- `id` uuid · `partido_id` uuid (FK → partidos, on delete cascade) · `cajera` text · `premio_cobrado` numeric (editable, override) · `notas` text · `creado_en`
- Columnas legacy (ya no se usan, se pueden dropear): `partido`, `fecha`, `hora`, `estado`, `resultado_ganador`.
- **Estado de la apuesta = derivado** (no se guarda): si el partido no tiene resultado → `Pendiente`; si lo tiene → `Cobrado` cuando hay premio (>0: alguna línea matchea el resultado del partido, o hay `premio_cobrado` manual), si no `Perdido`.

**`lineas`** — las casas dentro de una apuesta
- `id` uuid · `apuesta_id` uuid (FK, on delete cascade) · `casa` text · `monto_cargado` numeric (dinero real apostado) · `bono_pct` numeric (legacy, se guarda 0, ya no se usa) · `cuota` numeric · `resultado` text (qué resultado cubre) · `apuesta_gratis` numeric (NO cuenta como ingresado) · `orden` int

## 5. Lógica de cálculo (IMPORTANTE)

> **El bono NO se aplica en las apuestas.** Se da solo al **depositar** dinero en una cajera (se acredita al saldo, ver "Saldo por cajera"). Apostar no infla nada.

Por cada **línea** (casa):
- `apostado = monto_cargado` (sin bono)
- `premio_linea = monto_cargado × cuota + apuesta_gratis × (cuota − 1)`
  - La **apuesta gratis** paga `monto × (cuota − 1)` (la casa retiene el monto) y **no** es dinero ingresado. Verificado con Betano: $200.000 a cuota 6.60 → $1.120.000.

Por **apuesta**:
- `total_ingresado = Σ monto_cargado` (dinero real → **base del profit**)
- `premio` = `premio_cobrado` manual, o el de la(s) línea(s) cuyo `resultado` == `partido.resultado_ganador`
- `profit` = si Cobrado: `premio − total_ingresado` · si Perdido: `−total_ingresado` · si Pendiente (partido sin resolver): null
- `%` = `profit / total_ingresado × 100` (null si ingresado=0, ej. apuesta solo con apuesta gratis)

**Potencial por casa** (apuestas pendientes): por cada línea, `profit_potencial = premio_linea − total_ingresado` y su % sobre el total ingresado (muestra cuánto se ganaría si gana esa casa).

### Saldo por cajera (billetera, derivado)
El saldo **no se guarda**, se calcula, y **nunca queda negativo** (piso en 0). Solo las casas con `tiene_cajeras` (hoy **Vira**) mueven el saldo.
`saldo(cajera) = max(0, Σ efecto(movimientos) − Σ apostado_vira + Σ ganado_vira)`
- `efecto(Carga) = monto × (1 + bono_pct/100)` · `efecto(Retiro) = −monto`.
- `apostado_vira(apuesta) = Σ monto_cargado` de las líneas de casas con cajeras (se descuenta apenas existe la apuesta).
- `ganado_vira(apuesta) = Σ premio` de las líneas con cajera cuyo `resultado == partido.resultado_ganador` (se acredita al resolver el partido). Si gana una casa sin cajera, no acredita.
- El `max(0, …)` evita saldos negativos cuando se apuesta sin haber cargado dinero.

## 6. Funcionalidades implementadas
- **Tab Reportes:** KPIs (**Profit total** = profit de apuestas + **ganancia por bono** real de las cargas; **Ganancia por bono** = Σ monto cargado × bono% de las cargas, respeta período+cajera; Transferencia recibido = Σ premios cobrados, Total ingresado, **Total saldo cajeras actual** = Σ saldos de todas las cajeras, **Total en apuestas pendientes** = Σ ingresado de las pendientes, Apuestas resueltas, % promedio). Tablas: profit por mes, por cajera, dinero ingresado por casa. **Filtros:** período (Todo / Última semana / Último mes / Personalizado), cajera, rango de monto ingresado.
- **Tab Partidos** (home por defecto): listado de **partidos** en tarjetas, cada una con sus apuestas anidadas. **Chips de filtro** por estado de partido (Pendientes/Finalizados/Todos) con conteo; arranca en **Pendientes**. **Paginado** de 10 partidos.
  - **Flujo:** `+ Nuevo partido` (nombre, fecha, hora) → dentro del partido `+ Agregar apuesta` (cajera, casas/líneas, premio override, notas) → cuando termina el partido, `✅ Resolver` una vez y todas sus apuestas se resuelven solas.
  - **Tarjeta de partido:** header (nombre · fecha/hora · badge Pendiente/Finalizado · resultado ganador), totales agregados (nº apuestas, ingresado, profit si está resuelto), botones 🗑️/✏️ y ✅ Resolver / ↩️ Cambiar resultado.
  - **Balance por resultado** (partidos pendientes): por cada resultado posible, el profit total si gana ese resultado (Σ premios de las líneas que lo cubren − total ingresado del partido).
  - **Bono estimado** del partido (informativo, no suma al profit total): Σ por línea `monto_cargado × bp/(100+bp)` (el monto apostado ya incluye el bono, así que se "saca de adentro"; bp = bono% de la casa). El profit real del bono se cuenta en Reportes con el bono de las cargas.
  - **Apuesta (fila):** cajera, estado derivado, ingresado, premio/profit/% — **potencial por casa** si el partido está pendiente, **reales** si está resuelto. Botones 🗑️ / ✏️ Editar / 👁️ Detalle.
  - **Popup Resolver partido:** dropdown del resultado real (unión de los resultados cubiertos por las líneas de todas sus apuestas) + preview de cómo queda cada apuesta. Elegir "Pendiente" lo reabre.
  - **Popup Detalle (apuesta):** solo lectura, con datos del partido + tabla de casas + totales.
  - **Modal Nueva apuesta:** una fila por casa, **cada fila con su propia cajera**; al guardar se crea **una apuesta por cajera** (las filas de la misma cajera se agrupan). Arranca con una casa (Vira; configurable en `config.js` → `CASAS_POR_DEFECTO`). 🎁 "Apuesta gratis" solo en casas que lo permiten.
  - **Modal Editar apuesta:** una cajera + líneas + premio cobrado override + notas (modelo de una apuesta = una cajera).
- **Tab Cajeras:** una tarjeta por cajera con **saldo disponible** (nunca negativo, piso en 0) y desglose (cargado / apostado / ganado / retirado). Apostar descuenta; ganar acredita el premio. Botones:
  - **💵 Cargar:** el **casino sale de la cajera** (su `casa_id`) y el bono se autocompleta con el de esa casa (editable). Monto + checkbox "Con bono" (default ON) + nota; preview del saldo. Suma `monto × (1 + bono/100)`.
  - **🏧 Retirar:** monto + nota; avisa si deja el saldo negativo.
  - **📜 Movimientos:** historial (cargas/retiros manuales + débitos "Apuesta" y créditos "Premio" derivados de las apuestas), solo lectura.
- **Tab Configuración:** alta/baja de **casas** (nombre + **bono % al depositar** + checkbox "tiene cajeras" + checkbox "da apuesta gratis") y **cajeras** (nombre + **casino asociado**; cada cajera tiene un dropdown para cambiar su casino).

## 7. Setup desde cero (si hiciera falta)
1. Crear proyecto en supabase.com → SQL Editor → correr `supabase-schema.sql`.
2. Settings → API → copiar URL + publishable/anon key en `config.js`.
3. Abrir `index.html` (o deployar).

## 8. Deploy (flujo actual)
Repo conectado a Vercel. **Cada `git push` a `main` redespliega solo.**
```
git add -A
git commit -m "..."
git push origin main
```
Vercel sirve los archivos estáticos desde la raíz (Framework: Other, sin build).
Alternativa sin Git: arrastrar la carpeta `dist/` a https://app.netlify.com/drop

## 9. Seguridad y pendientes
- ⚠️ **Sin login todavía:** RLS desactivado; cualquiera con la URL + key puede ver/editar. La key es "publishable" (pensada para el cliente), pero los datos quedan públicos. **Pendiente prioritario: agregar Supabase Auth + políticas RLS.**
- ⚠️ La contraseña de la DB quedó escrita en `supabase-schema.sql` (gitignored, no se publicó). Conviene **resetearla** en Supabase (Settings → Database → Reset database password).
- Ideas futuras: login, exportar a Excel/CSV, gráfico de profit acumulado, PWA instalable, filtros/buscador en el listado de apuestas.

## 10. Historial de commits (hitos)
- `App de historial de apuestas (HTML + JS + Supabase)` — versión inicial (carga, cálculos, reportes, responsive).
- `Agrega apuesta gratis (free bet) por casa` — columnas `permite_gratis` / `apuesta_gratis` + migración.
- `Filtros por estado, potenciales por casa, popups Resolver y Detalle, iconos` — chips de estado, potencial por casa, hora "hs", popups Resolver/Detalle, iconos y reordenamiento de botones.
- `Partidos como entidad que agrupa N apuestas` — nueva tabla `partidos` + FK `apuestas.partido_id` (migración `migracion-partidos.sql`). Tab **Partidos** (home) con apuestas anidadas; resultado real se carga una vez en el partido y el estado de cada apuesta se deriva. Cajera queda por apuesta.
- `Billetera/saldo por cajera + bono solo al depositar` — nueva tabla `movimientos` + `casas.tiene_cajeras` (migración `migracion-cajeras-saldo.sql`). Tab **Cajeras** con saldo (Cargar/Retirar/Movimientos, piso en 0). Solo las casas con cajeras (Vira) mueven el saldo: apostar descuenta el monto real y ganar acredita el premio. El **bono 20% se da solo al depositar** (se acredita al saldo) y **se quitó del cálculo de apuestas** (apostado = monto, premio = monto × cuota). Datos reseteados de cero (`reset-datos.sql`) para no migrar.
