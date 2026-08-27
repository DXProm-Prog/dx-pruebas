// Envía correos usando la API de Brevo (HTTPS), NO usando SMTP — Render
// bloquea las conexiones SMTP salientes en el plan gratuito, así que
// usamos una API web normal, que sí funciona sin restricciones.

function isConfigured() {
  return Boolean(process.env.BREVO_API_KEY && process.env.SENDER_EMAIL);
}

async function sendEmail({ to, subject, text }) {
  if (!isConfigured() || !to) {
    return { sent: false, reason: "Brevo no configurado o falta destinatario" };
  }

  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": process.env.BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: {
          email: process.env.SENDER_EMAIL,
          name: process.env.SENDER_NAME || "Democracia por Promedio",
        },
        to: [{ email: to }],
        subject,
        textContent: text,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Brevo respondió ${res.status}: ${errBody}`);
    }
    return { sent: true };
  } catch (err) {
    console.error("Error enviando correo (Brevo):", err.message);
    return { sent: false, reason: err.message };
  }
}

async function notifyNewJoinRequest({ adminEmail, groupName, applicantName }) {
  return sendEmail({
    to: adminEmail,
    subject: `Nueva solicitud para unirse a "${groupName}"`,
    text: `${applicantName} quiere unirse a tu grupo "${groupName}" en Democracia por Promedio. Entra a la app para aprobar o rechazar la solicitud.`,
  });
}

async function notifyGroupCreated({ adminEmail, groupName, code, frontendUrl }) {
  const link = frontendUrl
    ? `${frontendUrl}${frontendUrl.includes("?") ? "&" : "?"}code=${code}`
    : null;

  return sendEmail({
    to: adminEmail,
    subject: `Tu grupo "${groupName}" ya está listo`,
    text: [
      `Creaste el grupo "${groupName}" en Democracia por Promedio.`,
      ``,
      `Código para invitar personas: ${code}`,
      link ? `Link directo: ${link}` : null,
      ``,
      `Comparte el código o el link con quienes quieras invitar.`,
    ]
      .filter(Boolean)
      .join("\n"),
  });
}

module.exports = { notifyNewJoinRequest, notifyGroupCreated, isConfigured };
