// Envía un correo al administrador cuando alguien pide unirse a su grupo.
// Si no hay configuración de SMTP en el .env, simplemente no envía nada
// (no rompe el resto de la app).

const nodemailer = require("nodemailer");

function isConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function notifyNewJoinRequest({ adminEmail, groupName, applicantName }) {
  if (!isConfigured() || !adminEmail) return { sent: false, reason: "SMTP no configurado o el grupo no tiene correo de administrador" };

  try {
    const transport = getTransport();
    await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: adminEmail,
      subject: `Nueva solicitud para unirse a "${groupName}"`,
      text: `${applicantName} quiere unirse a tu grupo "${groupName}" en Democracia por Promedio. Entra a la app para aprobar o rechazar la solicitud.`,
    });
    return { sent: true };
  } catch (err) {
    console.error("No se pudo enviar el correo de notificación:", err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = { notifyNewJoinRequest, isConfigured };
