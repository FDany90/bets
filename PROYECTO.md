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
| `index.html` | Página principal (tabs Reportes / Apuestas / Configuración) |
| `app.js` | Toda la lógica: estado, cálculos, render, modales, CRUD a Supabase |
| `styles.css` | Estilos (tema oscuro, responsive: tabla → tarjetas en mobile) |
| `config.js` | URL + publishable key de Supabase + casas por defecto |
| `supabase-schema.sql` | Esquema completo (para instalar de cero). **Gitignored** (tiene la contraseña en un comentario). |
| `migracion-apuesta-gratis.sql` | Migración que agregó las columnas de apuesta gratis |
| `dist/` | Copia de los 4 archivos web para Netlify Drop (gitignored) |
| `README.md` | Pasos de puesta en marcha |
| `.gitignore` | Excluye `*.sql`, `dist/`, etc. (para no publicar secretos) |

> Nota: los `*.sql` están gitignored, así que **no** se suben a la web ni al repo. Son solo para correr en el SQL Editor de Supabase.

## 4. Modelo de datos (tablas Supabase)

**`casas`** — catálogo de casas de apuestas
- `id` uuid · `nombre` text único · `bono_pct` numeric (ej. Vira=20, Betano=0) · `permite_gratis` boolean (da "apuesta gratis", ej. Betano=true) · `creado_en`

**`cajeras`** — catálogo de cajeras
- `id` uuid · `nombre` text único · `creado_en`

**`apuestas`** — una apuesta = un partido/evento
- `id` uuid · `partido` text · `fecha` date · `hora` text · `cajera` text · `estado` ('Pendiente'|'Cobrado'|'Perdido') · `resultado_ganador` text · `premio_cobrado` numeric (editable, se autocompleta) · `notas` text · `creado_en`

**`lineas`** — las casas dentro de una apuesta
- `id` uuid · `apuesta_id` uuid (FK, on delete cascade) · `casa` text · `monto_cargado` numeric (dinero real, SIN bono) · `bono_pct` numeric (copiado de la casa, editable) · `cuota` numeric · `resultado` text (qué resultado cubre) · `apuesta_gratis` numeric (NO cuenta como ingresado) · `orden` int

## 5. Lógica de cálculo (IMPORTANTE)

Por cada **línea** (casa):
- `apostado = monto_cargado × (1 + bono_pct/100)`
- `premio_linea = apostado × cuota + apuesta_gratis × (cuota − 1)`
  - El **bono** infla lo apostado pero **no** es costo.
  - La **apuesta gratis** paga `monto × (cuota − 1)` (la casa retiene el monto) y **no** es dinero ingresado. Verificado con Betano: $200.000 a cuota 6.60 → $1.120.000.

Por **apuesta**:
- `total_ingresado = Σ monto_cargado` (solo dinero real → **base del profit**)
- `total_apostado = Σ apostado`
- `premio` = `premio_cobrado` manual, o el de la(s) línea(s) cuyo `resultado` == `resultado_ganador`
- `profit` = si Cobrado: `premio − total_ingresado` · si Perdido: `−total_ingresado` · si Pendiente: null
- `%` = `profit / total_ingresado × 100` (null si ingresado=0, ej. apuesta solo con apuesta gratis)

**Potencial por casa** (apuestas pendientes): por cada línea, `profit_potencial = premio_linea − total_ingresado` y su % sobre el total ingresado (muestra cuánto se ganaría si gana esa casa).

## 6. Funcionalidades implementadas
- **Tab Reportes:** KPIs (Profit total, Transferencia recibido = Σ premios cobrados, Total ingresado, % promedio). Tablas: profit por mes, por cajera, dinero ingresado por casa. **Filtros:** período (Todo / Última semana / Último mes / Personalizado), cajera, rango de monto ingresado.
- **Tab Apuestas:** listado (tabla en PC, tarjetas en mobile). **Chips de filtro** por estado con conteo. **Paginado** de 10. Por cada apuesta:
  - Botones: 🗑️ eliminar y ✏️ Editar (izquierda) · ✅ Resolver y 👁️ Detalle (derecha).
  - **Pendiente:** muestra Premio/Profit/% **potencial por casa**. Hora con "hs" automático.
  - **Resuelta:** muestra Premio/Profit/% reales.
  - **Popup Resolver:** solo Estado + Resultado ganador + Premio cobrado (autocompletado), con preview de profit. No hay que editar toda la apuesta.
  - **Popup Detalle:** solo lectura, con datos generales + tabla de casas + totales.
  - **Modal Nueva/Editar:** datos + líneas dinámicas (arranca con Vira y Betano). Campo 🎁 "Apuesta gratis" visible solo en casas que lo permiten. Cálculos en vivo.
- **Tab Configuración:** alta/baja de **casas** (nombre + bono % + checkbox "da apuesta gratis") y **cajeras** (dropdown en los formularios).

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
