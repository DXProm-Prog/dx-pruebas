# Backend — Democracia por Promedio

Guarda todo (grupos, miembros, preguntas, respuestas y resultados) en un
archivo local `data.json`. Puede avisarle por correo al administrador
cuando alguien pide unirse a su grupo, y permite exportar todo a `.csv`.

## 1. Requisitos

- Tener [Node.js](https://nodejs.org) instalado (versión 18 o más nueva).

## 2. Instalar y correr el servidor

```bash
cd backend
npm install
cp .env.example .env
npm start
```

Deberías ver: `Servidor de Democracia por Promedio escuchando en http://localhost:4000`

## 3. Configurar el correo automático (opcional pero recomendado)

Si dejas el `.env` sin tocar en la parte de `SMTP_*`, la app funciona
igual, solo que no manda avisos por correo. Para activarlo con una cuenta
de Gmail:

1. Ve a tu [cuenta de Google](https://myaccount.google.com/security) y
   activa la **verificación en 2 pasos** (si no la tienes ya).
2. Busca **"Contraseñas de aplicaciones"** (App Passwords) — puedes ir
   directo a [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
3. Crea una nueva, ponle un nombre como "Democracia por Promedio", y
   copia la contraseña de 16 caracteres que te da (sin espacios).
4. En tu archivo `.env`, pon:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=tu-correo@gmail.com
   SMTP_PASS=la-contraseña-de-16-caracteres
   SMTP_FROM=tu-correo@gmail.com
   ```
5. Reinicia el servidor (`Ctrl + C` y luego `npm start` otra vez).

Ahora, cada vez que alguien use "Unirme con un código", el administrador
del grupo (si puso su correo al crear el grupo) recibirá un aviso.

## 4. Probar los endpoints

Ver `curl` de ejemplo en `DEPLOY.md` o usa directamente la app visual
(el archivo `.html`), que ya no necesita comandos para nada de esto.

## 5. Exportar a CSV

```
http://localhost:4000/api/groups/TU_CODIGO/export/respuestas.csv
http://localhost:4000/api/groups/TU_CODIGO/export/resultados.csv
```

## 6. Desplegar en internet (para no depender de tu computadora)

Ver `DEPLOY.md` — ahí está la guía completa para subir esto a GitHub y
dejarlo corriendo 24/7 gratis en Render.

## 7. Qué falta para producción

- **Autenticación real de usuarios** (ahora mismo cualquiera que sepa el
  código del grupo y el memberId puede enviar respuestas en nombre de
  otro).
- **Validaciones** (ej. que un mismo miembro no pueda responder dos veces
  la misma pregunta).
- **Base de datos más robusta** si va a haber muchos grupos activos a la
  vez — importante si despliegas en Render con el plan gratuito, ver la
  nota sobre esto en `DEPLOY.md`.
