const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Credenciais Z-API
const INSTANCE_ID = process.env.ZAPI_INSTANCE_ID || '3F69591CB7BA626697BA46186AAB5C98';
const TOKEN       = process.env.ZAPI_TOKEN       || '2DDDB2453A59055BC4B7C12F';
const BARBEIRO    = process.env.BARBEIRO_PHONE   || '5571981243829';

// Arquivo de agendamentos
const DB_FILE = path.join(__dirname, 'bookings.json');
function loadBookings() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return []; }
}
function saveBookings(list) {
  fs.writeFileSync(DB_FILE, JSON.stringify(list, null, 2));
}

function fmtPhone(phone) {
  let p = phone.replace(/\D/g, '');
  if (!p.startsWith('55')) p = '55' + p;
  return p;
}

const MONTHS = {
  janeiro:0,fevereiro:1,'marco':2,abril:3,maio:4,junho:5,
  julho:6,agosto:7,setembro:8,outubro:9,novembro:10,dezembro:11
};
function parseDate(dateStr, timeStr) {
  const tokens = dateStr.toLowerCase().split(/\s+de\s+/);
  const day   = parseInt(tokens[0]);
  const month = MONTHS[tokens[1]?.trim().normalize('NFD').replace(/[̀-ͯ]/g,'')] ?? 0;
  const year  = parseInt(tokens[2]);
  const [h, m] = (timeStr || '00:00').split(':').map(Number);
  return new Date(year, month, day, h, m, 0);
}

async function sendMsg(phone, message) {
  const url = `https://api.z-api.io/instances/${INSTANCE_ID}/token/${TOKEN}/send-text`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: fmtPhone(phone), message })
    });
    const data = await res.json();
    console.log(`[WhatsApp] -> ${phone}:`, data);
    return data;
  } catch (err) {
    console.error('[WhatsApp] Erro:', err.message);
  }
}

function msgConfirmacao(b) {
  return `*Agendamento confirmado!*\n\nOla, *${b.name}*! Seu agendamento na *Gomes Barbearia* foi confirmado.\n\n*Servico:* ${b.service}\n*Data:* ${b.date}\n*Horario:* ${b.time}\n*Valor:* ${b.price}\n${b.obs ? '*Obs:* ' + b.obs + '\n' : ''}\nQualquer duvida e so responder aqui. Te esperamos!`;
}

function msgLembreteVespera(b) {
  return `*Lembrete de amanha!*\n\nOi, *${b.name}*! Passando para lembrar que seu corte na *Gomes Barbearia* e amanha.\n\n*Servico:* ${b.service}\n*Horario:* ${b.time}\n\nQualquer imprevisto nos avise!`;
}

function msgLembrete10min(b) {
  return `*10 minutos para o seu corte!*\n\nOi, *${b.name}*! Seu atendimento comeca em 10 minutos na *Gomes Barbearia*.\n\n${b.service} as ${b.time}\n\nTe esperamos!`;
}

function msgNovoBarbeiro(b) {
  return `*Novo agendamento!*\n\n*Cliente:* ${b.name}\n*WhatsApp:* ${b.phone}\n*Servico:* ${b.service}\n*Data:* ${b.date}\n*Horario:* ${b.time}\n*Valor:* ${b.price}\n${b.obs ? '*Obs:* ' + b.obs : ''}`;
}

cron.schedule('* * * * *', async () => {
  const now  = new Date();
  const list = loadBookings();
  let changed = false;
  for (const b of list) {
    if (b.done) continue;
    const appt = parseDate(b.date, b.time);
    const diffMin = (appt - now) / 60000;
    if (!b.sent24h && diffMin >= 23 * 60 && diffMin <= 24 * 60) {
      await sendMsg(b.phone, msgLembreteVespera(b));
      b.sent24h = true; changed = true;
      console.log(`[Lembrete 24h] ${b.name}`);
    }
    if (!b.sent10min && diffMin >= 8 && diffMin <= 12) {
      await sendMsg(b.phone, msgLembrete10min(b));
      b.sent10min = true; changed = true;
      console.log(`[Lembrete 10min] ${b.name}`);
    }
    if (diffMin < -30) { b.done = true; changed = true; }
  }
  if (changed) saveBookings(list);
});

app.post('/booking', async (req, res) => {
  const { name, phone, service, date, time, price, duration, email, age, obs } = req.body;
  if (!phone || !name || !service) return res.status(400).json({ error: 'Dados incompletos' });
  const booking = {
    id: Date.now(), name, phone, service, date, time, price, duration, email, age, obs,
    sent24h: false, sent10min: false, done: false, createdAt: new Date().toISOString()
  };
  const list = loadBookings();
  list.push(booking);
  saveBookings(list);
  await sendMsg(phone, msgConfirmacao(booking));
  await sendMsg(BARBEIRO, msgNovoBarbeiro(booking));
  console.log(`[Agendamento] ${name} - ${service} - ${date} ${time}`);
  res.json({ success: true });
});

app.get('/bookings', (req, res) => res.json(loadBookings()));
app.get('/', (req, res) => res.json({ status: 'online', bot: 'Gomes Barbearia Bot' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot rodando na porta ${PORT}`));
