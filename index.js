const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ── Credenciais Z-API ──────────────────────────────────────────
const INSTANCE_ID = process.env.ZAPI_INSTANCE_ID || '3F69591CB7BA626697BA46186AAB5C98';
const TOKEN       = process.env.ZAPI_TOKEN       || '2DDDB2453A59055BC4B7C12F';
const BARBEIRO    = process.env.BARBEIRO_PHONE   || '5521998086350'; // número do barbeiro

// ── Arquivo de agendamentos para persistência ──────────────────
// Usa /data se um Railway Volume estiver montado lá; caso contrário usa o diretório da app
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const DB_FILE = path.join(DATA_DIR, 'bookings.json');
const BLOCKED_FILE = path.join(DATA_DIR, 'blocked.json');
console.log(`[DB] Usando arquivo: ${DB_FILE}`);
function loadBookings() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return []; }
}
function saveBookings(list) {
  fs.writeFileSync(DB_FILE, JSON.stringify(list, null, 2));
}
function loadBlocked() {
  try { return JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf8')); } catch { return {}; }
}
function saveBlocked(data) {
  fs.writeFileSync(BLOCKED_FILE, JSON.stringify(data, null, 2));
}
const MONTHS_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
function isoToLabel(iso) {
  const [y, m, d] = iso.split('-');
  return `${parseInt(d)} de ${MONTHS_PT[parseInt(m)-1]} de ${y}`;
}

// ── Utilitários ────────────────────────────────────────────────
function fmtPhone(phone) {
  let p = phone.replace(/\D/g, '');
  if (!p.startsWith('55')) p = '55' + p;
  return p;
}

const MONTHS = {
  janeiro:0,fevereiro:1,'março':2,abril:3,maio:4,junho:5,
  julho:6,agosto:7,setembro:8,outubro:9,novembro:10,dezembro:11
};
function parseDate(dateStr, timeStr) {
  // dateStr: "27 de Julho de 2026"  |  timeStr: "11:00"
  const parts = dateStr.toLowerCase().replace(' de ', '|').split('|');
  // parts: ["27", "julho", "2026"]  (splitting "27 de julho de 2026")
  const tokens = dateStr.toLowerCase().split(/\s+de\s+/);
  const day   = parseInt(tokens[0]);
  const month = MONTHS[tokens[1]?.trim()] ?? 0;
  const year  = parseInt(tokens[2]);
  const [h, m] = (timeStr || '00:00').split(':').map(Number);
  return new Date(year, month, day, h, m, 0);
}

// ── Enviar mensagem via Z-API ─────────────────────────────────
const CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || 'Fe090c89e53a64d7b91d90012e658860dS';

async function sendMsg(phone, message) {
  const url = `https://api.z-api.io/instances/${INSTANCE_ID}/token/${TOKEN}/send-text`;
  const hdrs = { 'Content-Type': 'application/json', 'Client-Token': CLIENT_TOKEN };

  const send = async (p) => {
    try {
      const r = await fetch(url, { method: 'POST', headers: hdrs, body: JSON.stringify({ phone: p, message }) });
      const d = await r.json();
      console.log('[WhatsApp] ->', p, JSON.stringify(d));
      return d;
    } catch (e) { console.error('[WhatsApp] Erro:', e.message); }
  };

  const p1 = fmtPhone(phone);
  await send(p1);

  // Para números BR com 9 extra (13 dígitos), tenta também sem o 9
  // pois contas antigas ficaram registradas no formato de 8 dígitos
  if (p1.length === 13 && p1.startsWith('55') && p1[4] === '9') {
    const p2 = '55' + p1.substring(2, 4) + p1.substring(5);
    await send(p2);
  }
}

// ── Mensagens ─────────────────────────────────────────────────
function msgConfirmacao(b) {
  return (
    `✅ *Agendamento confirmado!*\n\n` +
    `Olá, *${b.name}*! Seu agendamento na *Gomes Barbearia* foi confirmado. 💈\n\n` +
    `✂️ *Serviço:* ${b.service}\n` +
    `📅 *Data:* ${b.date}\n` +
    `⏰ *Horário:* ${b.time}\n` +
    `💰 *Valor:* ${b.price}\n` +
    (b.obs ? `📝 *Obs:* ${b.obs}\n` : '') +
    `\n📍 *Localização:*\nR. Nossa Sra. do Carmo, 721 - 2º andar, Salvador/BA\nhttps://maps.google.com/?q=-12.91173,-38.42943\n\n` +
    `Qualquer dúvida é só responder aqui. Te esperamos! 🤝`
  );
}

function msgLembreteVespera(b) {
  return (
    `📅 *Lembrete de amanhã!*\n\n` +
    `Oi, *${b.name}*! Passando para lembrar que seu corte na *Gomes Barbearia* é amanhã.\n\n` +
    `✂️ *Serviço:* ${b.service}\n` +
    `⏰ *Horário:* ${b.time}\n\n` +
    `Qualquer imprevisto nos avise! 😊`
  );
}

function msgLembrete1h(b) {
  return (
    `⏰ *Seu corte é em 1 hora!*\n\n` +
    `Oi, *${b.name}*! Passando para lembrar que seu atendimento na *Gomes Barbearia* começa em 1 hora.\n\n` +
    `✂️ *Serviço:* ${b.service}\n` +
    `⏰ *Horário:* ${b.time}\n\n` +
    `Qualquer imprevisto nos avise! 😊`
  );
}

function msgLembrete10min(b) {
  return (
    `⏰ *10 minutos para o seu corte!*\n\n` +
    `Oi, *${b.name}*! Seu atendimento começa em 10 minutos na *Gomes Barbearia*.\n\n` +
    `✂️ ${b.service} às ${b.time}\n\n` +
    `Te esperamos! 💈`
  );
}

function msgAvaliacao(b) {
  return (
    `⭐ *Como foi seu corte?*\n\n` +
    `Oi, *${b.name}*! Esperamos que tenha gostado do atendimento na *Gomes Barbearia*. 💈\n\n` +
    `Deixa sua avaliação respondendo com uma nota de *1 a 5* e um comentário se quiser.\n\n` +
    `Sua opinião é muito importante pra gente! 🙏`
  );
}

function msgClienteFaltou(b) {
  return (
    `⚠️ *Cliente faltou*\n\n` +
    `👤 *${b.name}* não compareceu ao horário das *${b.time}*.\n` +
    `✂️ Serviço: ${b.service}\n` +
    `📱 WhatsApp: ${b.phone}`
  );
}

function msgNovoBarbeiro(b) {
  return (
    `🔔 *Novo agendamento!*\n\n` +
    `👤 *Cliente:* ${b.name}\n` +
    `📱 *WhatsApp:* ${b.phone}\n` +
    `✂️ *Serviço:* ${b.service}\n` +
    `📅 *Data:* ${b.date}\n` +
    `⏰ *Horário:* ${b.time}\n` +
    `💰 *Valor:* ${b.price}\n` +
    (b.obs ? `📝 *Obs:* ${b.obs}` : '')
  );
}

// ── Verificar e disparar lembretes ────────────────────────────
cron.schedule('* * * * *', async () => {
  const now  = new Date();
  const list = loadBookings();
  let changed = false;

  for (const b of list) {
    if (b.done) continue;
    const appt = parseDate(b.date, b.time);
    const diffMin = (appt - now) / 60000; // minutos restantes

    // Lembrete na véspera: entre 23h e 24h antes
    if (!b.sent24h && diffMin >= 23 * 60 && diffMin <= 24 * 60) {
      await sendMsg(b.phone, msgLembreteVespera(b));
      b.sent24h = true;
      changed = true;
      console.log(`[Lembrete 24h] enviado para ${b.name}`);
    }

    // Lembrete 1h antes (cobre agendamentos de última hora)
    if (!b.sent1h && diffMin >= 55 && diffMin <= 65) {
      await sendMsg(b.phone, msgLembrete1h(b));
      b.sent1h = true;
      changed = true;
      console.log(`[Lembrete 1h] enviado para ${b.name}`);
    }

    // Lembrete 10 minutos antes
    if (!b.sent10min && diffMin >= 8 && diffMin <= 12) {
      await sendMsg(b.phone, msgLembrete10min(b));
      b.sent10min = true;
      changed = true;
      console.log(`[Lembrete 10min] enviado para ${b.name}`);
    }

    // Detectar falta: passou 30min sem confirmação de presença
    if (!b.faltouNotif && !b.compareceu && diffMin < -30 && diffMin > -60) {
      await sendMsg(BARBEIRO, msgClienteFaltou(b));
      b.faltouNotif = true;
      changed = true;
      console.log(`[Faltou] notificado barbeiro sobre ${b.name}`);
    }

    // Avaliação pós-corte: ~2h após o horário
    if (!b.sentAvaliacao && diffMin < -110 && diffMin > -130) {
      await sendMsg(b.phone, msgAvaliacao(b));
      b.sentAvaliacao = true;
      changed = true;
      console.log(`[Avaliação] enviada para ${b.name}`);
    }

    // Marcar como concluído após 3h do corte
    if (diffMin < -180) {
      b.done = true;
      changed = true;
    }
  }

  if (changed) saveBookings(list);
});

// ── Rota: novo agendamento (chamada pelo site) ─────────────────
app.post('/booking', async (req, res) => {
  const { name, phone, service, date, time, price, duration, email, age, obs } = req.body;

  if (!phone || !name || !service) {
    return res.status(400).json({ error: 'Dados incompletos' });
  }

  const booking = {
    id: Date.now(),
    name, phone, service, date, time, price, duration, email, age, obs,
    sent24h: false, sent10min: false, done: false,
    createdAt: new Date().toISOString()
  };

  // Salvar agendamento
  const list = loadBookings();
  list.push(booking);
  saveBookings(list);

  // Enviar confirmação para o cliente
  await sendMsg(phone, msgConfirmacao(booking));

  // Notificar barbeiro
  await sendMsg(BARBEIRO, msgNovoBarbeiro(booking));

  console.log(`[Agendamento] ${name} - ${service} - ${date} ${time}`);
  res.json({ success: true, message: 'Agendamento confirmado e WhatsApp enviado!' });
});

// ── Rota: listar agendamentos (debug) ─────────────────────────
app.get('/bookings', (req, res) => {
  res.json(loadBookings());
});

// ── Rotas: horários bloqueados ─────────────────────────────────
// GET /blocks?date=YYYY-MM-DD  → retorna array de slots bloqueados no dia
app.get('/blocks', (req, res) => {
  const { date } = req.query;
  const blocked = loadBlocked();
  res.json(date ? (blocked[date] || []) : blocked);
});

// POST /blocks  { date: 'YYYY-MM-DD', slot: 'HH:MM' }
app.post('/blocks', (req, res) => {
  const { date, slot } = req.body;
  if (!date || !slot) return res.status(400).json({ error: 'date e slot obrigatórios' });
  const blocked = loadBlocked();
  if (!blocked[date]) blocked[date] = [];
  if (!blocked[date].includes(slot)) blocked[date].push(slot);
  saveBlocked(blocked);
  console.log(`[Block] ${date} ${slot} bloqueado`);
  res.json({ success: true });
});

// DELETE /blocks  { date: 'YYYY-MM-DD', slot: 'HH:MM' }
app.delete('/blocks', (req, res) => {
  const { date, slot } = req.body;
  if (!date || !slot) return res.status(400).json({ error: 'date e slot obrigatórios' });
  const blocked = loadBlocked();
  if (blocked[date]) {
    blocked[date] = blocked[date].filter(s => s !== slot);
    if (!blocked[date].length) delete blocked[date];
    saveBlocked(blocked);
  }
  console.log(`[Block] ${date} ${slot} desbloqueado`);
  res.json({ success: true });
});

// GET /available?date=YYYY-MM-DD  → { date, booked: [...], blocked: [...] }
app.get('/available', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date obrigatório (YYYY-MM-DD)' });
  const list = loadBookings();
  const blocked = loadBlocked();
  const localDate = isoToLabel(date);
  const dayBookings = list.filter(b => b.date === localDate && !b.done);
  const bookedSlots = dayBookings.map(b => b.time);
  res.json({ date, booked: bookedSlots, blocked: blocked[date] || [] });
});

// DELETE /booking/by-slot  { date: 'YYYY-MM-DD', slot: 'HH:MM' }  — cancela + WhatsApp
app.delete('/booking/by-slot', async (req, res) => {
  const { date, slot } = req.body;
  if (!date || !slot) return res.status(400).json({ error: 'date e slot obrigatórios' });
  const localDate = isoToLabel(date);
  const list = loadBookings();
  const booking = list.find(b => b.date === localDate && b.time === slot && !b.done);
  if (!booking) {
    return res.json({ success: true, message: 'Nenhum agendamento no bot para esse slot.' });
  }
  const msg =
    `😔 *Agendamento cancelado*\n\n` +
    `Olá, *${booking.name}*! Infelizmente precisamos cancelar seu agendamento.\n\n` +
    `✂️ *Serviço:* ${booking.service}\n` +
    `📅 *Data:* ${booking.date}\n` +
    `⏰ *Horário:* ${booking.time}\n\n` +
    `Entre em contato pelo WhatsApp para reagendar. Pedimos desculpas pelo inconveniente! 🙏`;
  await sendMsg(booking.phone, msg);
  saveBookings(list.filter(b => b !== booking));
  console.log(`[Cancel by-slot] ${booking.name} ${booking.date} ${booking.time}`);
  res.json({ success: true, message: `${booking.name} cancelado e notificado.` });
});

// ── Rota: cancelar agendamento individual (barbeiro cancela) ──
app.delete('/booking/:id', async (req, res) => {
  const id = Number(req.params.id);
  const list = loadBookings();
  const booking = list.find(b => b.id === id);
  if (!booking) return res.status(404).json({ error: 'Agendamento não encontrado' });

  // Notificar o cliente
  const msg =
    `😔 *Agendamento cancelado*\n\n` +
    `Olá, *${booking.name}*! Infelizmente precisamos cancelar seu agendamento.\n\n` +
    `✂️ *Serviço:* ${booking.service}\n` +
    `📅 *Data:* ${booking.date}\n` +
    `⏰ *Horário:* ${booking.time}\n\n` +
    `Entre em contato pelo WhatsApp para reagendar. Pedimos desculpas pelo inconveniente! 🙏`;
  await sendMsg(booking.phone, msg);

  // Remover da lista
  const updated = list.filter(b => b.id !== id);
  saveBookings(updated);
  res.json({ success: true, message: `Agendamento de ${booking.name} cancelado e cliente notificado.` });
});

// ── Rota: limpar todos os agendamentos ────────────────────────
app.delete('/bookings', (req, res) => {
  saveBookings([]);
  res.json({ success: true, message: 'Todos os agendamentos foram removidos.' });
});

// ── Rota: status do servidor ──────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'online', bot: 'Gomes Barbearia Bot', time: new Date().toISOString() });
});

// ── Iniciar servidor ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 Bot Gomes Barbearia rodando na porta ${PORT}`);
  console.log(`📱 Z-API Instance: ${INSTANCE_ID}`);
});
