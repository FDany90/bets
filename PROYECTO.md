# 📊 Proyecto Apuestas — Documentación

> Documento de referencia con todo lo construido. Sirve para retomar el proyecto en el futuro (incluso tras borrar el chat de Claude).
> Última actualización: 2026-06-25.

---

## 1. Qué es
App web para registrar apuestas y llevar el historial de ganancias, reemplazando un Google Sheet ("Apuests 2"). Permite cargar apuestas con varias casas, calcular profit/% automáticamente y ver reportes. Funciona en **celular y PC** con datos en la nube.

## 2. Stack tecnológico
- **Frontend:** HTML + CSS + JavaScript **vanilla, sin build** (se sirve estático, sin bundler). Supabase se carga desde CDN. (Node sí está instalado en la PC —v24— pero la app no lo necesita; solo se usa para tooling como instalar skills.)
- **Diseño:** tema oscuro **glassmorphism** (tarjetas translúcidas con blur, gradientes de fondo), responsive (tabla → tarjetas en mobile). **Navegación inferior** estilo app (bottom nav con íconos) + header sticky con título, "Última actualización" y botón 🔄 Refresh.
- **Base de datos:** Supabase (PostgreSQL). API REST automática (PostgREST).
- **Hosting:** Vercel (deploy automático desde GitHub).
- **Repo:** https://github.com/FDany90/bets (privado)
- **Supabase project ref:** `lmwwmeixxibhuiqrovdm` → URL `https://lmwwmeixxibhuiqrovdm.supabase.co`

## 3. Estructura de archivos
| Archivo | Qué es |
|---|---|
| `index.html` | Página principal (header sticky + bottom nav: Reportes / Partidos / Cajeras / Config) |
| `app.js` | Toda la lógica: estado, cálculos, render, modales, CRUD a Supabase |
| `styles.css` | Estilos (tema oscuro, responsive: tabla → tarjetas en mobile) |
| `config.js` | URL + publishable key de Supabase + casas por defecto |
| `supabase-schema.sql` | Esquema completo (para instalar de cero). **Gitignored** (tiene la contraseña en un comentario). |
| `migracion-apuesta-gratis.sql` | Migración que agregó las columnas de apuesta gratis |
| `migracion-partidos.sql` | Migración que creó la tabla `partidos` y la FK `apuestas.partido_id` (agrupa N apuestas por partido) |
| `migracion-cajeras-saldo.sql` | Migración que creó la tabla `movimientos` (billetera por cajera) y `casas.tiene_cajeras` |
| `migracion-bono-por-casa.sql` | Migración que agregó `movimientos.casa` (bono de depósito configurable por casa) |
| `migracion-cajera-casa.sql` | Migración que agregó `cajeras.casa_id` (cada cajera pertenece a un casino) |
| `migracion-retiros-ganancia.sql` | Migración que creó la tabla `retiros_ganancia` (reparto; baja el profit actual) |
| `migracion-cajera-saldo-retiro.sql` | Migración que agregó `cajeras.saldo_retiro` (flag manual: cajera lista para retirar) |
| `migracion-cajera-pendiente-retiro.sql` | Migración que agregó `cajeras.pendiente_retiro` (flag manual: bloqueo visual rojo, saldo a la espera de retirar) |
| `migracion-partido-bono-retiro.sql` | Migración que agregó `partidos.bono_retiro` (snapshot del bono por saldo de retiro al resolver) |
| `migracion-partido-bono-apuestas.sql` | Migración que agregó `partidos.bono_apuestas` (snapshot editable del bono de depósito al resolver; congela el histórico) |
| `migracion-cuentas-transferencias.sql` | Migración que agregó `cajeras.es_cuenta` + tablas `config` (ajustes globales) y `transferencias` (cajero↔cuenta con comisión) |
| `migracion-admins.sql` | Migración que agregó la tabla `admins` (dueños) + `cajeras.admin_id` (agrupar/filtrar cajeros y cuentas por admin) |
| `migracion-casa-filtro.sql` | Migración que agregó `casas.mostrar_filtro` (marca qué casinos aparecen en el filtro por casino del sub-tab Cajeros) |
| `migracion-transferencia-bono.sql` | Migración que agregó `transferencias.bono_pct_destino` / `bono_destino` (bono de depósito al transferir a un cajero) |
| `migracion-bonos.sql` | Migración que agregó la tabla `bonos` (listado de %) + `apuestas.bono_pct` (bono elegido por apuesta, para profit) |
| `migracion-propina.sql` | Migración que agregó `movimientos.propina` y `transferencias.propina` (propina al retirar/transferir; gasto contra profit) |
| `migracion-cajera-activo.sql` | Migración que agregó `cajeras.activo` (desactivar un cajero para la carga de apuestas) |
| `reset-datos.sql` | Borra partidos/apuestas/líneas/movimientos (empezar de cero), mantiene casas y cajeras |
| `dist/` | Copia de los 4 archivos web para Netlify Drop (gitignored) |
| `README.md` | Pasos de puesta en marcha |
| `.gitignore` | Excluye `*.sql`, `dist/`, `.agents/` + `skills-lock.json` (tooling de skills), etc. |

> Nota: los `*.sql` están gitignored, así que **no** se suben a la web ni al repo. Son solo para correr en el SQL Editor de Supabase.

## 4. Modelo de datos (tablas Supabase)

**`casas`** — catálogo de casas de apuestas
- `id` uuid · `nombre` text único · `bono_pct` numeric (**bono de depósito por casa**, ej. Vira=20, SuperPro=10; se aplica al cargar dinero, NO en las apuestas) · `tiene_cajeras` boolean (sus líneas descuentan/acreditan el saldo de la cajera, ej. Vira=true) · `permite_gratis` boolean (da "apuesta gratis", ej. Betano=true) · `mostrar_filtro` boolean (si true, aparece en el **filtro por casino** del sub-tab Cajeros; se marca con un checkbox en Config) · `creado_en`

**`cajeras`** — catálogo de cajeras + billetera (saldo). Incluye también las **cuentas** (personas).
- `id` uuid · `nombre` text único · `casa_id` uuid (FK → casas; el casino al que pertenece, define el bono al depositar) · `es_cuenta` boolean (**true = cuenta**: persona a la que se le transfiere plata; NO es un cajero para apostar, no se asocia a casino ni aparece en las apuestas; se muestra en una sub-tab aparte) · `admin_id` uuid (FK → admins, on delete set null; **dueño** del cajero/cuenta, para agrupar/filtrar; null = sin admin) · `activo` boolean (default true; si false, el cajero **no aparece al cargar apuestas** —sigue existiendo con su saldo/historial; se reactiva en Config) · `saldo_retiro` boolean (**flag manual**: la cajera ya tiene saldo cargado para poder retirar; resalta la card en verde) · `pendiente_retiro` boolean (**flag manual** independiente: bloqueo visual, tiene saldo a la espera de retirar y no se debe tocar; resalta la card y el monto en **rojo**, gana sobre el verde; solo visual) · `creado_en`
- El **saldo no se guarda**: se calcula en vivo (ver tabla `movimientos`, `transferencias` y sección 5).

**`admins`** — dueños de cajeros/cuentas (para agrupar y filtrar)
- `id` uuid · `nombre` text único · `creado_en`. Se asocian vía `cajeras.admin_id`.

**`bonos`** — listado de bonos elegibles (%)
- `id` uuid · `porcentaje` numeric único (15, 20, …) · `creado_en`. Se administran en Config y se eligen (chips) al transferir a un cajero y al cargar una apuesta.

**`config`** — ajustes globales clave/valor
- `clave` text (PK) · `valor` text. Hoy guarda `comision_cuenta_pct` (% de comisión de las cuentas, default 5).

**`transferencias`** — mueve plata entre un cajero y una cuenta (con comisión / bono)
- `id` uuid · `origen_id` uuid (FK → cajeras, on delete set null) · `destino_id` uuid (FK → cajeras) · `origen_nombre` / `destino_nombre` text (snapshots por si se borra la cajera) · `monto` numeric (lo que sale del origen) · `comision_pct` / `comision` numeric (solo cajero → cuenta) · `bono_pct_destino` / `bono_destino` numeric (**snapshot** del bono de depósito del casino del cajero destino; solo cuenta → cajero) · `propina` numeric (propina pagada; no toca saldos, se resta del profit) · `nota` text · `creado_en`
- Efecto: origen −`monto`, destino +(`monto` − `comision` + `bono_destino`). La `comision` (solo al entrar a una **cuenta**) es un **gasto** que baja el profit. El `bono_destino` (solo al entrar a un **cajero** con casino) infla el saldo del cajero, igual que una Carga con bono (no es profit directo). Historial propio, separado de `retiros_ganancia`.

**`movimientos`** — cargas y retiros manuales de dinero por cajera
- `id` uuid · `cajera_id` uuid (FK → cajeras, on delete cascade) · `tipo` text ('Carga'|'Retiro'|'Ganancia') · `monto` numeric (base ingresado, positivo) · `bono_pct` numeric (bono aplicado en la carga; 0 si sin bono/retiro) · `casa` text (en qué casa se cargó, define el bono) · `propina` numeric (solo Retiro: propina pagada; **no toca el saldo**, se resta del profit) · `nota` text · `creado_en`
- Los débitos/créditos por apuestas **no** se guardan acá: se derivan de las apuestas.

**`partidos`** — un partido/evento que agrupa N apuestas
- `id` uuid · `nombre` text · `fecha` date · `hora` text · `resultado_ganador` text (null = Pendiente; con valor = Finalizado) · `bono_retiro` numeric (**snapshot** al resolver: Σ por cajera del partido con `saldo_retiro` on de `saldo × bono%_de_la_última_carga/100`; suma al profit. Al resolver se **apaga** `saldo_retiro` de esas cajeras → se cuenta una sola vez) · `bono_apuestas` numeric (snapshot legacy del bono por partido; ya no se escribe, pero se usó **una vez** para restaurar `apuestas.bono_pct` sin perder el profit histórico —ver `migrarBonoApuestas`, flag `config.bono_apuestas_migrado`) · `creado_en`
- Estado del partido **derivado**: `Pendiente` si `resultado_ganador` es null, `Finalizado` si tiene valor.

**`apuestas`** — una apuesta dentro de un partido (un set de casas/líneas)
- `id` uuid · `partido_id` uuid (FK → partidos, on delete cascade) · `cajera` text · `premio_cobrado` numeric (editable, override) · `bono_pct` numeric (**bono elegido del listado** para esta apuesta; 0 = sin bono; null = viejo → la app lo completa con el bono de la casa. NO afecta lo apostado; suma al profit: bono = ingresado × %/(100+%)) · `notas` text · `creado_en`
- Columnas legacy (ya no se usan, se pueden dropear): `partido`, `fecha`, `hora`, `estado`, `resultado_ganador`.
- **Estado de la apuesta = derivado** (no se guarda): si el partido no tiene resultado → `Pendiente`; si lo tiene → `Cobrado` cuando hay premio (>0: alguna línea matchea el resultado del partido, o hay `premio_cobrado` manual), si no `Perdido`.

**`retiros_ganancia`** — reparto de ganancias (no es por cajera)
- `id` uuid · `monto` numeric · `nota` text · `creado_en`
- **Profit total actual** = profit histórico − Σ retiros_ganancia. El histórico no se toca.

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
`saldo(cajera) = max(0, Σ efecto(movimientos) − Σ apostado_vira + Σ ganado_vira + transferIn − transferOut)`
- `efecto(Carga) = monto × (1 + bono_pct/100)` · `efecto(Retiro) = −monto`.
- `transferOut = Σ monto` de las transferencias donde la cajera es **origen** (sale el monto completo).
- `transferIn = Σ (monto − comision + bono_destino)` de las transferencias donde la cajera es **destino**. La `comision` (solo al entrar a una cuenta) no vuelve a nadie: es gasto contra profit. El `bono_destino` (solo al entrar a un cajero con casino) es el bono de depósito que infla el saldo.
- `apostado_vira(apuesta) = Σ monto_cargado` de las líneas de casas con cajeras (se descuenta apenas existe la apuesta).
- `ganado_vira(apuesta) = Σ premio` de las líneas con cajera cuyo `resultado == partido.resultado_ganador` (se acredita al resolver el partido). Si gana una casa sin cajera, no acredita.
- El `max(0, …)` evita saldos negativos cuando se apuesta sin haber cargado dinero.

### Bono por "saldo de retiro" (al resolver un partido)
Marcador manual `cajeras.saldo_retiro`: se prende cuando a la cajera ya se le cargó el saldo necesario para **retirar** ganancias. Al **resolver un partido por primera vez**:
- Por cada **cajera distinta** de las apuestas del partido con `saldo_retiro` on: bono `= saldo_actual × bono%_de_la_última_carga / 100` (saldos del momento, antes de aplicar el resultado). El `bono%` sale del `bono_pct` de la **Carga más reciente** de ese cajero (o de la transferencia entrante más reciente, si es posterior).
- La suma se guarda como **snapshot** en `partidos.bono_retiro` (no se recalcula después) y **suma al profit** (card del partido y Reportes).
- Se **apaga `saldo_retiro`** de esas cajeras → si la misma cajera está en otro partido sin resolver, **no se cuenta de nuevo** (se cuenta una sola vez). Volver el partido a Pendiente pone `bono_retiro = 0` (no reactiva el flag automáticamente).

## 6. Funcionalidades implementadas

**Navegación y feedback global**
- **Header sticky:** título ⚽ Apuestas + **"Última actualización"** (fecha/hora del `creado_en` más reciente, con tiempo relativo "Hace 1 hora / 1 día 5 horas", refresca solo cada minuto) + botón **🔄 Refresh** (re-baja todo del servidor y re-renderiza; útil para re-sincronizar si se editó desde otro dispositivo).
- **Bottom nav fija** (estilo app): 📊 Reportes · 🥅 Partidos · 👩 Cajeras · ⚙️ Config.
- **Feedback:** barra de progreso global durante operaciones de red, `:active` en botones, spinner en botones de submit, fade del contenido al cambiar de vista. Operaciones de cajera y del toggle de saldo de retiro son **optimistas** (UI instantánea, persiste en segundo plano, revierte si falla).

**Tab Reportes** — KPIs en orden: **Profit total actual** (= histórico − Σ retiros de ganancia) · **Profit total histórico** (= Σ profit real de resueltas + Σ **bono por apuesta** (`ingresado × %/(100+%)`, % elegido en la apuesta) + ganancias manuales + Σ `bono_retiro` de partidos resueltos **menos Σ `comision`** de transferencias **menos Σ propinas** (retiros + transferencias)). El **bono por apuesta y las propinas respetan el filtro de cajera**; `bono_retiro` y comisiones se omiten con filtro de cajera. KPIs extra **Comisiones cuentas** y **Propinas** (negativos). Botones **💸 Retirar ganancia**, **📜 Retiros**, **🔁 Transferencias**, **💵 Propinas** (informe con el detalle y el total). · Transferencia recibido · Total ingresado · Total saldo cajeras actual · Total en apuestas pendientes · Apuestas resueltas · % promedio. Botones **💸 Retirar ganancia** y **📜 Retiros**. Tablas: profit por mes, por cajera, ingresado por casa. **Filtros:** período (Todo / Semana / Mes / Personalizado), cajera, rango de ingresado. (Con filtro de cajera, el `bono_retiro` se omite por ser un agregado por partido.)

**Tab Partidos** (home) — tarjetas de partido con apuestas anidadas. **Orden:** pendientes por **fecha/hora ascendente** (el más próximo primero); **finalizados descendente** (el más reciente primero); en "Todos" van los pendientes arriba y los finalizados abajo. **Chips** Pendientes/Finalizados/Todos (arranca en Pendientes). **Paginado** de 10.
  - **Flujo:** `+ Nuevo partido` → dentro `+ Agregar apuesta` (botón ghost, chico, arriba de la tabla) → `✅ Resolver` una vez.
  - **Tarjeta:** **título grande coloreado por estado** (ámbar=Pendiente, azul=Finalizado) + **borde lateral y superior** del mismo color (separa visualmente dónde empieza cada partido), header + totales (nº apuestas, ingresado, profit, **Bono estimado**, **Bono retiro**, **Profit + bono (est.)** = profit + bono estimado + bono retiro). Botones 🗑️/✏️, ✅ Resolver / ↩️ Cambiar resultado. **Desplegable** con toggle "▸ Más / ▾ Menos".
  - **Apuesta (fila):** **nombre de la cajera** (en **verde + ✓** si tiene `saldo_retiro` activado) + **saldo actual** (chico, gris) · resultado/cuota por casa · ingresado · premio (potencial si pendiente) · profit (oculto si pendiente, real si resuelto). Botones 🗑️/✏️/👁️. (Se quitaron las columnas Estado y profit potencial.)
  - **Popup Resolver:** dropdown del resultado + preview por apuesta (el bono ya no se elige acá: es el de cada apuesta, ver abajo) + preview por apuesta + **bloque de totales**: Profit total cajeras · Bono de depósito (el editado) · Bono por saldo de retiro · **Total** (grande). Al guardar **consume el saldo de retiro** de esas cajeras (se cuenta una sola vez) y **activa "Pendiente de retiro"** (rojo) en todas las cajeras del partido. "Pendiente" lo reabre (anula ambos bonos; descongela `bono_apuestas`; **no** desactiva el rojo, se hace a mano al retirar).
  - **Premio por resultado** (solo partidos pendientes): por cada resultado posible, el **premio total** que se cobraría (Σ de todas las apuestas del partido) si sale ese resultado. Ordenado de mayor a menor. (Reemplazó al "Balance por resultado".)
  - **Bono apuestas** (en la tarjeta): Σ del bono elegido en cada apuesta (`ingresado × %/(100+%)`).
  - **Bono por saldo de retiro:** ver sección 5.
  - **Modal Nueva apuesta:** una fila por casa (cajera, casa, cargado, cuota, resultado) + **chips de Bono** (elegís el % del listado, o "Sin bono"); agrupa por cajera (una apuesta por cajera). Al **elegir la cajera se autocompleta la Casa** con su casino asignado (`casa_id`). El bono queda en `apuestas.bono_pct` (no afecta lo apostado; suma al profit). **Modal Editar** (bono a nivel apuesta) **/ Detalle** por apuesta.

**Cuentas (personas) y transferencias** — Las **cuentas** (`cajeras.es_cuenta = true`) son personas a las que se les transfiere plata; se administran igual que los cajeros (saldo/movimientos) pero **no apuestan** (no aparecen en apuestas ni en los modales Cargar/Retirar/Ganancia). Una **transferencia** cajero↔cuenta mueve saldo. La **comisión** (global, `config.comision_cuenta_pct`, 5% default) se cobra **solo cuando el dinero entra a una cuenta (cajero → cuenta)**; en el sentido cuenta → cajero **no** hay comisión. Además, en **cuenta → cajero** se acredita un **bono de depósito** al saldo del cajero, **elegido del listado de bonos** (chips; default = el del casino si está en el listado), snapshot al momento (monto × %/100), igual que una Carga con bono. El origen baja `monto`, el destino recibe `monto − comisión + bono`, y la comisión es un **gasto que baja el profit histórico y actual** (el bono solo infla saldo). Una transferencia también cuenta como **actividad** (ordena la card del cajero/cuenta arriba). Tiene su **historial propio** (`transferencias`, botón 🔁 Transferencias). El **informe de Reportes muestra solo las cajero → cuenta** (las que cobran comisión), con el total transferido y el total de comisión. Con filtro de cajera en Reportes la comisión se omite (gasto no atribuible a una cajera).

**Tab Cajeras** — **sub-tabs (chips)** *Cajeros* / *Cuentas* + **filtro por Admin** (Todos / cada admin / Sin admin; aplica a ambos sub-tabs y a los totales) + **filtro por Casino** (solo en el sub-tab Cajeros; lista solo los casinos con `mostrar_filtro` marcado en Config). El admin del cajero/cuenta se muestra en la card. Card de resumen arriba (Saldo total del tab; en Cajeros además Total apostado). Botón **🔁 Transferir** (elige sentido cajero↔cuenta, monto; preview de comisión/bono y neto) en ambos tabs y **por card** (en cada cajero al lado de Cargar, y en cada cuenta). El **sentido y la entidad arrancan preseleccionados** según desde dónde se abre: card de cajero → *Cuenta → Cajero* con ese cajero; card de cuenta → *Cajero → Cuenta* con esa cuenta; botón global según el sub-tab (Cajeros → *Cuenta → Cajero*, Cuentas → *Cajero → Cuenta*). Las **cuentas** muestran una card simple (saldo + recibido neto + enviado + botones Transferir/Movimientos, sin toggles de apuesta). Una tarjeta por cajera con:
  - **Saldo disponible** (piso en 0) + **badge de disponibilidad de retiro** (se puede retirar cada **24 h** desde el último retiro: verde **"✅ Retiro disponible"** si pasaron 24 h o nunca retiró, ámbar **"⏳ Retiro disponible en 3 h 20 m"** con cuenta regresiva si falta) + **Apostado (pendiente)** + lista de **Partidos pendientes** con su monto. (Se quitaron los totales históricos cargado/ganado/retirado.) Ordenadas por **última actividad**.
  - **Toggle "Saldo de retiro"** (flag manual): al prenderlo la card se **resalta en verde** (borde + badge). Indica que la cajera ya tiene saldo cargado para retirar; se consume al resolver un partido.
  - **Toggle "🔒 Pendiente de retiro"** (flag manual independiente): al prenderlo la card **y el monto del saldo** se resaltan en **rojo** (bloqueo visual; gana sobre el verde si ambos están activos). Indica que tiene un saldo a la espera de ser retirado y que no se debe tocar hasta hacer el retiro. Solo visual, no afecta cálculos. **Se activa automáticamente** en todas las cajeras de un partido al **resolverlo por primera vez**; se apaga a mano (al hacer el retiro real). Optimista.
  - Botones **💵 Cargar** (casino sale de la cajera, bono auto-completado), **🔁 Transferir**, **🏧 Retirar** (con campo **Propina** opcional: no toca saldo, se resta del profit), **💰 Ganancia** (suma al profit, no mueve saldo), **📜 Movimientos** (historial con **fecha y hora**; **cargas/retiros/ganancias y transferencias borrables** desde acá, revierten el saldo). Las transferencias también se borran desde 📜 Transferencias.

**Tab Configuración** — alta/baja de **casas** (tiene cajeras / da apuesta gratis + **Bono % editable** + checkbox **🔎 Mostrar en filtro**), **cajeras/cuentas** (nombre + **casino asociado** + **admin asignado** + toggle **✅ apuestas** —desactiva el cajero para la carga de apuestas (`activo`)— + toggle **👤 cuenta** editable en cada fila —convierte un cajero existente en cuenta y viceversa; al marcarla como cuenta se le saca el casino—, o checkbox **👤 Es cuenta** al crearla) y **admins** (alta/baja) y **bonos** (listado de %: alta/baja; se eligen al transferir y al cargar apuestas). Card **Ajustes**: **Comisión de cuentas (%)** global editable (`config.comision_cuenta_pct`).

## 7. Setup desde cero (si hiciera falta)
1. Crear proyecto en supabase.com → SQL Editor → correr `supabase-schema.sql`.
2. Correr las migraciones **en este orden** (cada una agrega tablas/columnas; todas están en la raíz, gitignored):
   1. `migracion-apuesta-gratis.sql` — columnas de apuesta gratis.
   2. `migracion-partidos.sql` — tabla `partidos` + `apuestas.partido_id`.
   3. `migracion-cajeras-saldo.sql` — tabla `movimientos` + `casas.tiene_cajeras`.
   4. `migracion-bono-por-casa.sql` — `movimientos.casa`.
   5. `migracion-cajera-casa.sql` — `cajeras.casa_id`.
   6. `migracion-retiros-ganancia.sql` — tabla `retiros_ganancia`.
   7. `migracion-cajera-saldo-retiro.sql` — `cajeras.saldo_retiro`.
   8. `migracion-partido-bono-retiro.sql` — `partidos.bono_retiro`.
   9. `migracion-cajera-pendiente-retiro.sql` — `cajeras.pendiente_retiro`.
   10. `migracion-partido-bono-apuestas.sql` — `partidos.bono_apuestas`.
   11. `migracion-cuentas-transferencias.sql` — `cajeras.es_cuenta` + tablas `config` y `transferencias`.
   12. `migracion-admins.sql` — tabla `admins` + `cajeras.admin_id`.
   13. `migracion-casa-filtro.sql` — `casas.mostrar_filtro`.
   14. `migracion-transferencia-bono.sql` — `transferencias.bono_pct_destino` / `bono_destino`.
   15. `migracion-bonos.sql` — tabla `bonos` + `apuestas.bono_pct`.
   16. `migracion-propina.sql` — `movimientos.propina` + `transferencias.propina`.
   17. `migracion-cajera-activo.sql` — `cajeras.activo`.
   - `reset-datos.sql` (opcional): borra partidos/apuestas/líneas/movimientos, mantiene casas/cajeras.
3. Settings → API → copiar URL + publishable/anon key en `config.js`.
4. Abrir `index.html` (o deployar). En Configuración: setear Bono % de cada casa, marcar "tiene cajeras", y asociar cada cajera a su casino.

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
- `Profit histórico vs actual + retiros de ganancia` — tabla `retiros_ganancia` (baja el profit actual, no el histórico). Bono % editable por casa. Ganancia manual por cajera. Alta multi-cajera.
- `Rediseño de UI (glassmorphism) + UX` — tema glass (cards translúcidas, gradientes, fondo casi negro), icono ⚽, **bottom nav** con íconos, header sticky con "Última actualización" (con "Hace X") y botón 🔄 Refresh. Feedback: barra de progreso, spinner de submit, fade, **operaciones de cajera optimistas**. Cards de cajera "en vivo" (saldo + apostado pendiente + partidos pendientes) ordenadas por actividad + **card de resumen** (saldo/apostado total). Partidos ordenados por fecha/hora, título grande, borde lateral por estado. Fila de apuesta más limpia (sin Estado ni profit potencial, con saldo de la cajera). Reportes: Profit actual primero. (Aplicado con guidelines de la skill `web-design-guidelines` de Vercel, instalada vía `npx skills add`; queda en `.agents/` gitignored.)
- `Saldo de retiro por cajera + bono al resolver` — `cajeras.saldo_retiro` (flag manual, toggle + resaltado verde; nombre verde en Partidos) y `partidos.bono_retiro` (snapshot al resolver: Σ `saldo × bono%` de las cajeras del partido con saldo de retiro; suma al profit). Al resolver se **consume** el flag (se cuenta una sola vez). Popup Resolver con bloque de totales (profit cajeras + bono estimado + bono retiro + Total grande).
