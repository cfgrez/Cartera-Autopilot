# Cartera Autopilot

Dashboard web de la rentabilidad y las posiciones del fondo. Sin framework, sin paso
de compilación: HTML, CSS y JavaScript nativo, más un Cloudflare Worker que sirve los
archivos y trae las cotizaciones en vivo.

- **Datos** en un solo archivo: `public/data/portfolio.json`
- **Cálculo** en `public/assets/engine.js` (funciones puras, con tests)
- **Cotizaciones** vía `/api/quotes`, que corre en el Worker, en el borde de Cloudflare
- **Respaldo**: si la API falla, cada posición usa el `lastPrice` del JSON
- **Editor** en `/editar`: registra compras, ventas (totales o parciales) y aportes,
  y guarda con un commit a GitHub — o te devuelve el JSON para pegar a mano

---

## Estructura

```
.
├── src/
│   ├── index.js               # Worker: enruta la API y sirve los assets
│   ├── quotes.js              # cotizaciones en vivo
│   └── save.js                # guarda portfolio.json vía GitHub API
├── public/                    # assets estáticos
│   ├── index.html             # dashboard
│   ├── editar.html            # formulario para registrar movimientos
│   ├── assets/
│   │   ├── app.js             # render, gráficos, tablas
│   │   ├── editor.js          # formulario, validaciones, salida JSON
│   │   ├── engine.js          # motor de cálculo (sin DOM)
│   │   ├── editor.css
│   │   └── styles.css
│   └── data/
│       └── portfolio.json     # ← el único archivo que editas seguido
├── test/
│   ├── engine.test.mjs
│   └── save.test.mjs
├── package.json
└── wrangler.toml
```

Es un **Worker con assets estáticos**, no un proyecto Pages. Cloudflare sirve primero
los archivos de `public/`; si la ruta no corresponde a ningún archivo, la petición
llega al Worker, que es lo que hace responder `/api/quotes`.

---

## Publicar en GitHub y Cloudflare

### 1. Subir el repositorio

```bash
cd cartera-autopilot
git init
git add .
git commit -m "Dashboard del fondo Autopilot"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/cartera-autopilot.git
git push -u origin main
```

### 2. Conectar Cloudflare

1. Panel de Cloudflare → **Workers & Pages** → **Create** → **Import a repository**
2. Autoriza GitHub y elige `cartera-autopilot`
3. Configuración de build:

   | Campo | Valor |
   |---|---|
   | Build command | *(vacío)* |
   | Deploy command | `npx wrangler deploy` |
   | Root directory | `/` |

4. **Save and Deploy**

`wrangler.toml` ya declara `main = "src/index.js"` y el directorio de assets, así que
`npx wrangler deploy` encuentra todo solo. Desde ahí, cada `git push` a `main`
redespliega.

> **Si el build falla con «Missing entry-point to Worker script»**, es señal de que
> `wrangler.toml` quedó configurado para Pages (con `pages_build_output_dir`) mientras
> el pipeline corre `wrangler deploy`. Este repo ya usa la configuración de Worker,
> que es la que corresponde. Puedes verificarlo antes de subir con:
>
> ```bash
> npx wrangler deploy --dry-run
> ```

### 3. Variable opcional

`/api/quotes` funciona sin API key usando el endpoint público de Yahoo Finance. Si
prefieres Finnhub —más estable, plan gratuito con límite—, define el secret:

```bash
npx wrangler secret put FINNHUB_API_KEY
```

o en el panel del Worker: **Settings → Variables and Secrets → Add**. La función usa
Finnhub primero y cae a Yahoo si falla.

---

## Desarrollo local

```bash
npm install
npm run dev     # levanta el sitio y la API en http://localhost:8787
npm test        # corre los tests del motor de cálculo
```

`npm run dev` levanta el Worker en `http://localhost:8787` con los assets y la API,
igual que en producción.
Si abres `public/index.html` directo con doble clic, la API no responde y el sitio
cae al `lastPrice` del JSON: sirve para revisar el diseño, no para precios reales.

---

## Registrar movimientos

Hay dos caminos. El formulario es más cómodo y valida por ti; editar el JSON a mano
es más rápido si ya sabes lo que quieres escribir.

### Opción A — el formulario

Abre `/editar` (hay un botón **+ Movimiento** en el dashboard). Tiene tres pestañas:
compra, venta y aporte o retiro. Vas agregando movimientos, ves cómo queda la cartera
antes y después, y al final guardas.

**Guardar en GitHub** aparece si configuraste el guardado (ver más abajo): el Worker
hace el commit por ti y Cloudflare redespliega solo. Si no lo configuraste, o si
prefieres revisar antes, están **Copiar** y **Descargar** para pegar el JSON a mano.

Lo que valida antes de dejarte agregar algo:

- que la caja alcance para la compra;
- que no vendas más unidades de las que quedan abiertas;
- que la fecha de venta no sea anterior a la de compra;
- que no retires más plata de la que hay.

En la pestaña de venta hay botones de 25 / 50 / 75 / todo, y te dice en vivo cuánto
entra a caja, cuál es el resultado de esa venta y cuántas unidades quedarían abiertas.
Los movimientos sobreviven a un refresco del navegador (se guardan en `sessionStorage`),
pero no a cerrar la pestaña: guarda o copia antes de irte.

### Opción B — editar el JSON

**Comprar:**

```jsonc
{
  "id": 16,
  "ticker": "AMD",
  "qty": 2,
  "buyDate": "2026-08-14",
  "buyPrice": 178.40,
  "stop": 176.62,          // opcional, marca la fila si el precio cae bajo
  "status": "open",
  "lastPrice": 178.40      // respaldo si no hay cotización en vivo
}
```

**Vender**, total o parcial, con un array `sells` dentro de la misma operación:

```jsonc
{
  "id": 4, "ticker": "ARDX", "qty": 11,
  "buyDate": "2026-07-21", "buyPrice": 5.035,
  "sells": [
    { "date": "2026-08-14", "qty": 6, "price": 4.10 },   // venta parcial
    { "date": "2026-08-20", "qty": 5, "price": 4.50 }    // cierra el resto
  ]
}
```

No hay que declarar el estado: si queda saldo la posición sigue abierta y aparece
marcada como **parcial**; si `sells` suma la cantidad completa, se cierra sola.

**Aportar o retirar:**

```jsonc
"cashFlows": [
  { "date": "2026-09-01", "amount": 500, "note": "aporte" },
  { "date": "2026-10-15", "amount": -200, "note": "retiro" }
]
```

Esto mueve el capital base, así que la rentabilidad se sigue midiendo contra lo que
efectivamente pusiste.

> El formato antiguo —`status: "closed"` con `sellDate` y `sellPrice`— se sigue
> leyendo sin problema, como una venta única por la cantidad completa. No hay que
> migrar nada. El editor convierte la operación a `sells` solo cuando le agregas
> una venta nueva.

Después de editar a mano, corre `npm test`: uno de los tests verifica que la caja
siga cuadrando contra el resultado. Si guardas desde el editor, esa misma validación
la hace el Worker antes de escribir.

---

## Activar el guardado desde el navegador

Sin esto el editor funciona igual, solo que copiando y pegando. Con esto, el botón
**Guardar en GitHub** hace el commit desde el celular en dos toques.

### 1. Crear el token de GitHub

En GitHub: **Settings → Developer settings → Personal access tokens → Fine-grained
tokens → Generate new token**.

| Campo | Valor |
|---|---|
| Repository access | Only select repositories → `cartera-autopilot` |
| Permissions → Contents | **Read and write** |
| Expiration | lo que prefieras (anótalo, hay que renovarlo) |

No le des ningún otro permiso. Ese token solo puede tocar este repositorio.

### 2. Cargar los secrets en el Worker

```bash
npx wrangler secret put EDIT_TOKEN      # clave que te pedirá el editor
npx wrangler secret put GITHUB_TOKEN    # el token del paso anterior
npx wrangler secret put GITHUB_REPO     # tu-usuario/cartera-autopilot
```

Opcionales, si tu repo no usa los valores por defecto:

```bash
npx wrangler secret put GITHUB_BRANCH   # por defecto "main"
npx wrangler secret put GITHUB_PATH     # por defecto "public/data/portfolio.json"
```

Para `EDIT_TOKEN` usa algo largo y aleatorio, no una palabra:

```bash
openssl rand -base64 24
```

También puedes cargarlos desde el panel del Worker, en **Settings → Variables and
Secrets**. En desarrollo local van en un archivo `.dev.vars` (ya está en `.gitignore`).

### 3. Listo

Recarga `/editar` y aparecerá el botón. La primera vez te pide `EDIT_TOKEN` y lo
recuerda en ese dispositivo; **Olvidar clave** lo borra.

### Cómo está protegido

- El token de GitHub vive solo en el Worker. El navegador nunca lo ve.
- `EDIT_TOKEN` se compara en tiempo constante y una clave equivocada tarda 400 ms
  en responder, así que probar claves a ciegas es lento.
- Antes de escribir, el Worker valida la cartera con el mismo motor que usa el
  dashboard: rechaza cantidades negativas, ventas mayores a lo comprado, ventas
  anteriores a la compra, caja negativa, y cualquier cartera donde
  `caja + mercado` no cuadre con `capital + realizado + no realizado`.
- Si el archivo cambió en GitHub desde que abriste el editor, el commit se rechaza
  y te avisa en vez de pisar el cambio.
- Rotar la clave es un comando (`wrangler secret put EDIT_TOKEN`) y no requiere
  tocar el token de GitHub.

Si quieres una capa más, pon el sitio detrás de **Cloudflare Access** y exige tu
correo antes de que la petición llegue siquiera al Worker.

---

## Cómo se calcula

La caja no se guarda en ninguna parte: se deduce, y por eso siempre cuadra.

```
caja        = capital aportado − Σ(costo de todas las compras) + Σ(lo recibido en todas las ventas)
en mercado  = Σ(cantidad × precio actual) de las posiciones abiertas
patrimonio  = caja + en mercado
```

Y por el otro lado, como control cruzado:

```
patrimonio  = capital aportado + resultado realizado + resultado no realizado
```

El test `la identidad contable se cumple` verifica que ambas rutas den lo mismo.

Otras definiciones que conviene tener claras:

- **Resultado realizado**: ventas ya ejecutadas, incluidas las parciales. Ya está en la caja.
- **Resultado no realizado**: el saldo que sigue abierto, a precio de mercado. Se mueve solo.
  Una posición vendida a medias aporta a los dos: la parte vendida al realizado y el
  resto al no realizado.
- **Capital desplegado promedio**: cuánto estuvo realmente invertido, ponderado por
  los días que estuvo invertido. Sirve para separar el rendimiento de las decisiones
  del efecto de tener plata quieta en caja.
- **Profit factor**: dólares ganados divididos por dólares perdidos. Bajo 1 el sistema
  pierde plata; sobre 2 se considera sólido, aunque con 15 operaciones el número todavía
  es ruido más que señal.

---

## Advertencias

- El endpoint de Yahoo no es una API oficial ni tiene garantía de disponibilidad. Para
  algo de lo que dependas de verdad, usa un proveedor con contrato (Finnhub, Polygon,
  Alpha Vantage) y ajusta `src/quotes.js`.
- Los precios llegan con retraso de hasta 15 minutos y las respuestas se cachean 60
  segundos en el borde.
  
- El cálculo no descuenta comisiones, spreads ni impuestos. Si tu bróker cobra por
  operación, la rentabilidad real es algo menor que la que muestra el dashboard.
- Los ETF que reparten dividendos —como SGOV— bajan de precio en la fecha ex-dividendo.
  Como el dashboard mide solo precio, subestima el retorno de esas posiciones.

Proyecto de seguimiento personal. No es asesoría de inversión.
