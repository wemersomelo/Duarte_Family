'use strict';
// Envio de e-mails (aprovação de pedidos, aviso de pedido novo).
// Só funciona quando SMTP_HOST, SMTP_USER e SMTP_PASS estão no .env; sem eles, o site segue funcionando
// e o administrador manda o convite à mão, como antes.
const nodemailer = require('nodemailer');

let transport = null;
function configured() { return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS); }
const sent = []; // usado só nos testes (SMTP_HOST=test)
function getTransport() {
  if (!transport && process.env.SMTP_HOST === 'test') transport = nodemailer.createTransport({ jsonTransport: true });
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 465);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  }
  return transport;
}
// Nunca lança erro: devolve true se o e-mail saiu.
async function send(to, subject, text) {
  if (!configured() || !to) return false;
  try {
    const from = process.env.SMTP_FROM || `"Family Book" <${process.env.SMTP_USER}>`;
    await getTransport().sendMail({ from, to, subject, text });
    if (process.env.SMTP_HOST === 'test') sent.push({ to, subject, text });
    return true;
  } catch (err) {
    console.error('E-mail não enviado:', err.message);
    return false;
  }
}
module.exports = { send, configured, sent };
