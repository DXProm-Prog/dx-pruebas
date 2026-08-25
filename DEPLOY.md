# Subir el backend a GitHub y dejarlo corriendo en internet (Render)

GitHub por sí solo **no ejecuta** tu servidor — es solo donde vive el
código de forma segura, con historial de cambios. Para que el servidor
esté prendido todo el tiempo (sin que dependa de tu computadora ni de
tener la terminal abierta), lo conectamos a **Render**, un servicio que
sí ejecuta Node.js y que tiene un plan gratuito.

## Parte 1 — Subir el código a GitHub

1. Si no tienes cuenta, créala gratis en [github.com](https://github.com).
2. Dale clic al botón verde **"New"** (o el `+` de arriba a la derecha →
   "New repository").
3. Ponle un nombre, por ejemplo `democracia-por-promedio`. Déjalo en
   **Public** o **Private**, como prefieras. No marques ninguna casilla
   de "Add README" (ya tenemos uno). Dale clic en **Create repository**.
4. GitHub te va a mostrar una página con comandos. En tu terminal, dentro
   de la carpeta `backend`, corre uno por uno:

   ```bash
   git init
   git add .
   git commit -m "Primera versión del backend"
   git branch -M main
   git remote add origin https://github.com/TU_USUARIO/democracia-por-promedio.git
   git push -u origin main
   ```

   (Reemplaza `TU_USUARIO` por tu usuario de GitHub — la URL exacta te la
   da GitHub en esa misma página después de crear el repositorio).

5. Si es tu primera vez usando `git`, probablemente te pida iniciar
   sesión — sigue las instrucciones que aparezcan en pantalla o en el
   navegador.

Tu código ya está en GitHub. Puedes verlo entrando a
`https://github.com/TU_USUARIO/democracia-por-promedio`.

## Parte 2 — Desplegar en Render

1. Ve a [render.com](https://render.com) y crea una cuenta gratis
   (puedes usar tu cuenta de GitHub para entrar más rápido).
2. En el panel, dale clic a **"New" → "Web Service"**.
3. Conecta tu cuenta de GitHub si te lo pide, y selecciona el
   repositorio `democracia-por-promedio`.
4. Configura:
   - **Name**: lo que quieras, ej. `democracia-por-promedio`
   - **Region**: la más cercana a ti
   - **Branch**: `main`
   - **Root Directory**: déjalo vacío si `backend` es la raíz del repo
     (si subiste una carpeta más arriba que también incluye el frontend,
     pon `backend` aquí)
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. Antes de darle "Create", baja hasta **"Environment Variables"** y
   agrega las mismas variables de tu `.env` (menos `PORT`, Render la pone
   sola):
   ```
   SMTP_HOST = smtp.gmail.com
   SMTP_PORT = 587
   SMTP_USER = tu-correo@gmail.com
   SMTP_PASS = tu-contraseña-de-aplicación
   SMTP_FROM = tu-correo@gmail.com
   ```
6. Dale clic en **"Create Web Service"**. Render va a instalar todo y
   prender tu servidor — tarda uno o dos minutos. Cuando termine, te da
   una URL pública como:
   ```
   https://democracia-por-promedio.onrender.com
   ```

## Parte 3 — Apuntar la app visual a tu servidor en línea

1. Abre tu archivo `.html` de la app.
2. Hasta abajo de la pantalla, dale clic donde dice **"servidor:
   http://localhost:4000 ▼"**.
3. Reemplázalo por tu URL de Render (sin `/` al final), por ejemplo:
   ```
   https://democracia-por-promedio.onrender.com
   ```
4. Listo — ahora la app habla con tu servidor en internet, no con tu
   computadora. Puedes compartir el archivo `.html` con cualquiera y
   todos van a estar hablando con el mismo servidor central.

## Nota importante sobre el plan gratuito de Render

- El plan gratuito "apaga" el servidor si nadie lo usa por un rato, y
  tarda unos 30-60 segundos en volver a prender la primera vez que
  alguien lo usa después de estar dormido. Es normal, no es un error.
- El archivo `data.json` (donde vive toda tu información) **se puede
  borrar** cada vez que Render reinicia el servicio en el plan gratuito,
  porque el almacenamiento no es permanente ahí. Para un proyecto de
  prueba está bien, pero antes de usar esto con un grupo real, conviene
  migrar los datos a una base de datos de verdad (Render también ofrece
  Postgres gratis, es el siguiente paso natural).
