# Cartera Autopilot

Dashboard web de la rentabilidad y las posiciones del fondo. Sin framework, sin paso
de compilación: HTML, CSS y JavaScript nativo, más una Cloudflare Pages Function que
trae las cotizaciones en vivo.

- **Datos** en un solo archivo: `public/data/portfolio.json`
- **Cálculo** en `public/assets/engine.js` (funciones puras, con tests)
- **Cotizaciones** vía `/api/quotes`, que corre en el borde de Cloudflare
- **Respaldo**: si la API falla, cada posición usa el `lastPrice` del JSON

---

## Estructura

```
.
├── functions/
│   └── api/
│       └── quotes.js          # Pages Function: GET /api/quotes?symbols=VST,KGC
├── public/                    # todo lo que se publica
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

---

## Publicar en GitHub y Cloudflare Pages

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

### 2. Conectar Cloudflare Pages

1. Panel de Cloudflare → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. Autoriza GitHub y elige el repositorio `cartera-autopilot`
3. Configuración de build:

   | Campo | Valor |
   |---|---|
   | Framework preset | **None** |
   | Build command | *(vacío)* |
   | Build output directory | `public` |
   | Root directory | `/` |

4. **Save and Deploy**

Cloudflare detecta la carpeta `functions/` automáticamente y publica `/api/quotes`
junto al sitio. No hay que configurar nada más.

Desde ahí, cada `git push` a `main` redespliega solo.

### 3. Variable opcional

`/api/quotes` funciona sin API key usando el endpoint público de Yahoo Finance. Si
prefieres Finnhub —más estable, plan gratuito con límite—, define el secret:

```bash
npx wrangler pages secret put FINNHUB_API_KEY
```

o en el panel: **Settings → Variables and Secrets → Add**. La función usa Finnhub
primero y cae a Yahoo si falla.

---

## Desarrollo local

```bash
npm install
npm run dev     # levanta el sitio y las functions en http://localhost:8788
npm test        # corre los tests del motor de cálculo
```

`npm run dev` usa Wrangler, así que `/api/quotes` funciona igual que en producción.
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
  Alpha Vantage) y ajusta `functions/api/quotes.js`.
- Los precios llegan con retraso de hasta 15 minutos y las respuestas se cachean 60
  segundos en el borde.
- El cálculo no descuenta comisiones, spreads ni impuestos. Si tu bróker cobra por
  operación, la rentabilidad real es algo menor que la que muestra el dashboard.
- Los ETF que reparten dividendos —como SGOV— bajan de precio en la fecha ex-dividendo.
  Como el dashboard mide solo precio, subestima el retorno de esas posiciones.

Proyecto de seguimiento personal. No es asesoría de inversión.
