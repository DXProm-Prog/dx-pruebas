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

async function notifyNewJoinRequest({ adminEmail, groupName, applicantName, code, adminId, frontendUrl }) {
  const link =
    frontendUrl && code && adminId
      ? `${frontendUrl}${frontendUrl.includes("?") ? "&" : "?"}code=${code}&member=${adminId}`
      : null;

  return sendEmail({
    to: adminEmail,
    subject: `Nueva solicitud para unirse a "${groupName}"`,
    text: [
      `${applicantName} quiere unirse a tu grupo "${groupName}" en Democracia por Promedio.`,
      link ? `Entra aquí para aprobar o rechazar la solicitud:\n${link}` : `Entra a la app para aprobar o rechazar la solicitud.`,
    ].join("\n\n"),
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

// Correo de bienvenida para un miembro (no administrador) que se acaba
// de unir a un grupo, con la info básica para encontrarlo después.
async function notifyMemberJoined({ memberEmail, memberName, groupName, code, frontendUrl }) {
  const link = frontendUrl
    ? `${frontendUrl}${frontendUrl.includes("?") ? "&" : "?"}code=${code}`
    : null;

  return sendEmail({
    to: memberEmail,
    subject: `Te uniste a "${groupName}"`,
    text: [
      `Hola ${memberName}, te uniste al grupo "${groupName}" en Democracia por Promedio.`,
      ``,
      `Código del grupo: ${code}`,
      link ? `Link directo: ${link}` : null,
      ``,
      `Cuando el administrador te apruebe, vas a poder participar en las preguntas del grupo.`,
      `Cuando haya resultados, o si alguna pregunta necesita una ronda de desempate, te vamos a avisar aquí también.`,
    ]
      .filter(Boolean)
      .join("\n"),
  });
}

// Avisa a TODOS los miembros con correo registrado que una pregunta ya
// tiene resultado final (o que necesita una ronda de desempate).
async function notifyResultsToMembers({ group, questionText, summaryText, frontendUrl, subjectPrefix }) {
  const link = frontendUrl
    ? `${frontendUrl}${frontendUrl.includes("?") ? "&" : "?"}code=${group.code}`
    : null;

  const recipients = group.members.filter((m) => m.email);
  const results = await Promise.all(
    recipients.map((m) =>
      sendEmail({
        to: m.email,
        subject: `${subjectPrefix || "Resultado"}: "${questionText}"`,
        text: [
          `En el grupo "${group.name}":`,
          ``,
          summaryText,
          ``,
          link ? `Entra a la app para ver el proceso completo:\n${link}` : `Entra a la app para ver el proceso completo.`,
        ]
          .filter(Boolean)
          .join("\n"),
      })
    )
  );
  return results;
}

// Correo especial para quien propuso el proyecto ganador en una
// categoría del presupuesto.
async function notifyProposalWinner({ memberEmail, memberName, groupName, category, proposalName, code, frontendUrl }) {
  const link = frontendUrl
    ? `${frontendUrl}${frontendUrl.includes("?") ? "&" : "?"}code=${code}`
    : null;

  return sendEmail({
    to: memberEmail,
    subject: `¡Tu propuesta ganó! (${category})`,
    text: [
      `¡Felicidades, ${memberName}!`,
      ``,
      `Tu propuesta "${proposalName}" ganó la votación de la categoría "${category}" en "${groupName}".`,
      ``,
      link ? `Entra a la app para ver el detalle:\n${link}` : `Entra a la app para ver el detalle.`,
    ]
      .filter(Boolean)
      .join("\n"),
  });
}

module.exports = { notifyNewJoinRequest, notifyGroupCreated, notifyMemberJoined, notifyResultsToMembers, notifyProposalWinner, isConfigured };
