# 📊 Apuestas — App de historial

Reemplazo del Google Sheet para registrar apuestas, calcular profit/% automáticamente y ver reportes. Funciona en **celular y PC** con datos en la nube (Supabase). **No necesita instalar nada** (sin Node, sin build): es HTML + JavaScript + Supabase desde CDN.

## ¿Qué calcula sola?
Vos cargás por cada casa: **monto cargado** (dinero real) + **cuota**. El bono se autocompleta según la casa.
- `apostado = cargado × (1 + bono%)`
- `premio de la línea = apostado × cuota`
- Al resolver elegís el **resultado ganador** → el premio cobrado se toma de la línea ganadora (editable a mano)
- `Profit = Premio cobrado − Total ingresado (sin bono)`
- `% = Profit / Total ingresado`
- **Reportes:** profit total, transferencia recibido (Σ cobrados), profit por mes, por cajera y dinero ingresado por casa.

---

## Puesta en marcha (una sola vez, ~5 min)

### 1. Crear la base de datos en Supabase
1. Entrá a **https://supabase.com** y creá una cuenta (gratis).
2. **New project** → poné nombre y contraseña → esperá ~1 min a que termine.
3. En el menú izquierdo: **SQL Editor** → **New query**.
4. Abrí el archivo **`supabase-schema.sql`** de esta carpeta, copiá TODO y pegalo → **Run**.
   - Esto crea las tablas y deja Vira (bono 20%) y Betano (bono 0%) cargadas.

### 2. Conectar la app
1. En Supabase: **Settings (⚙️) → API**.
2. Copiá **Project URL** y la clave **anon public**.
3. Abrí **`config.js`** y pegalas reemplazando los valores de ejemplo.

### 3. Abrir la app
- Doble clic en **`index.html`** (o arrastralo al navegador). ¡Listo!

---

## Usarla desde el celular (publicarla gratis)
Para abrirla desde cualquier lado, subila a un hosting gratuito:

**Opción más fácil — Netlify Drop:**
1. Entrá a **https://app.netlify.com/drop**.
2. Arrastrá toda la carpeta `BETS`.
3. Te da un link (ej. `https://algo.netlify.app`) que abrís en el celu y la PC.

(También sirve Vercel o GitHub Pages.)

---

## 🔒 Privacidad (importante)
Por simplicidad, la base **no tiene login**: cualquiera con el link + la clave podría ver/editar los datos. Para una app personal suele alcanzar, pero si querés privacidad real, pedile a Claude que **agregue login (Supabase Auth) y políticas RLS**.

## Ideas para después
- Login / usuarios.
- Filtros y buscador en la lista de apuestas.
- Exportar a Excel/CSV.
- Gráfico de profit acumulado.
- App instalable en el celu (PWA).
