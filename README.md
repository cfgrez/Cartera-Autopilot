# Cartera Autopilot

Dashboard web de la rentabilidad y las posiciones del fondo. Sin framework, sin paso
de compilación: HTML, CSS y JavaScript nativo, más un Cloudflare Worker que sirve los
archivos y trae las cotizaciones en vivo.

- **Datos** en un solo archivo: `public/data/portfolio.json`
- **Cálculo** en `public/assets/engine.js` (funciones puras, con tests)
- **Cotizaciones** vía `/api/quotes`, que corre en el Worker, en el borde de Cloudflare
- **Respaldo**: si la API falla, cada posición usa el `lastPrice` del JSON

---

## Estructura

```
.
├── src/
│   ├── index.js               # Worker: enruta /api/quotes y sirve los assets
│   └── quotes.js              # lógica de cotizaciones
├── public/                    # assets estáticos
│   ├── index.html
│   ├── assets/
│   │   ├── app.js             # render, gráficos, tablas
│   │   ├── engine.js          # motor de cálculo (sin DOM)
│   │   └── styles.css
│   └── data/
│       └── portfolio.json     # ← el único archivo que editas seguido
├── test/
│   └── engine.test.mjs
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

## Actualizar la cartera

Todo vive en `public/data/portfolio.json`.

```jsonc
{
  "fund": {
    "name": "Cartera Autopilot",
    "currency": "USD",
    "initialCapital": 1000,        // capital aportado al inicio
    "startDate": "2026-07-21",
    "priceAsOf": "2026-08-12T12:58:56-04:00"
  },
  "cashFlows": [],                 // aportes o retiros posteriores
  "trades": [
    {
      "id": 1,
      "ticker": "QXO",
      "qty": 3,
      "buyDate": "2026-07-21",
      "buyPrice": 13.625,
      "stop": 13.48875,            // opcional: marca la fila si el precio cae bajo
      "status": "open",
      "lastPrice": 15.48           // respaldo si no hay cotización en vivo
    },
    {
      "id": 2,
      "ticker": "KTOS",
      "qty": 1,
      "buyDate": "2026-07-21",
      "buyPrice": 45.855,
      "status": "closed",
      "sellDate": "2026-08-05",
      "sellPrice": 55.065
    }
  ]
}
```

**Abrir una posición**: agrega un objeto con `status: "open"`.
**Cerrar una posición**: cambia `status` a `"closed"` y agrega `sellDate` y `sellPrice`.
**Aportar o retirar plata**: agrega una entrada a `cashFlows`, por ejemplo
`{ "date": "2026-09-01", "amount": 500, "note": "aporte" }`. Un retiro va en negativo.

Guardas, haces `git push` y el sitio se actualiza solo.

---

## Cómo se calcula

La caja no se guarda en ninguna parte: se deduce, y por eso siempre cuadra.

```
caja        = capital aportado − Σ(costo de todas las compras) + Σ(lo recibido en las ventas)
en mercado  = Σ(cantidad × precio actual) de las posiciones abiertas
patrimonio  = caja + en mercado
```

Y por el otro lado, como control cruzado:

```
patrimonio  = capital aportado + resultado realizado + resultado no realizado
```

El test `la identidad contable se cumple` verifica que ambas rutas den lo mismo.

Otras definiciones que conviene tener claras:

- **Resultado realizado**: solo operaciones cerradas. Ya está en la caja.
- **Resultado no realizado**: posiciones abiertas, a precio de mercado. Se mueve solo.
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
