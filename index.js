const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json());

const BARBEIRO = process.env.BARBEIRO_PHONE || '5521998086350';

// ── Arquivo de agendamentos para persistência ──────────────────
// Usa /data se um Railway Volume estiver montado lá; caso contrário usa o diretório da app
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const DB_FILE = path.join(DATA_DIR, 'bookings.json');
const BLOCKED_FILE = path.join(DATA_DIR, 'blocked.json');
const AUTH_DIR = path.join(DATA_DIR, 'auth_state');

console.log(`[DB] Usando arquivo: ${DB_FILE}`);
console.log(`[Auth] Diretório de sessão: ${AUTH_DIR}`);

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
  const tokens = dateStr.toLowerCase().split(/\s+de\s+/);
  const day   = parseInt(tokens[0]);
  const month = MONTHS[tokens[1]?.trim()] ?? 0;
  const year  = parseInt(tokens[2]);
  const [h, m] = (timeStr || '00:00').split(':').map(Number);
  return new Date(year, month, day, h, m, 0);
}

// ── WhatsApp via Baileys ───────────────────────────────────────
let sock = null;
let isConnected = false;
let currentQR = null;

async function connectWhatsApp() {
  try {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const logger = pino({ level: 'silent' });

    sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: true,
      browser: ['Gomes Barbearia', 'Chrome', '1.0.0'],
      connectTimeoutMs: 30000,
      defaultQueryTimeoutMs: 30000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        console.log('[WhatsApp] QR gerado — acesse /qr no navegador para escanear');
      }

      if (connection === 'close') {
        isConnected = false;
        currentQR = null;
        const statusCode = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode
          : 0;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`[WhatsApp] Conexão fechada. StatusCode: ${statusCode}. Reconectar: ${shouldReconnect}`);
        if (shouldReconnect) {
          console.log('[WhatsApp] Reconectando em 5 segundos...');
          setTimeout(connectWhatsApp, 5000);
        } else {
          // Deslogado pelo WhatsApp — limpa sessão e gera novo QR automaticamente
          console.log('[WhatsApp] Deslogado pelo WhatsApp. Limpando sessão e gerando novo QR em /qr...');
          try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
          setTimeout(connectWhatsApp, 3000);
        }
      } else if (connection === 'open') {
        isConnected = true;
        currentQR = null;
        console.log('[WhatsApp] ✅ Conectado com sucesso!');
      }
    });
  } catch (err) {
    console.error('[WhatsApp] Erro ao iniciar conexão:', err.message);
    setTimeout(connectWhatsApp, 10000);
  }
}

// Iniciar conexão WhatsApp
connectWhatsApp();

// ── Enviar mensagem via Baileys ────────────────────────────────
async function sendMsg(phone, message) {
  if (!sock || !isConnected) {
    console.error(`[WhatsApp] ⚠️ Bot não conectado — mensagem não enviada para ${phone}`);
    return;
  }

  const p1 = fmtPhone(phone);
  const p2 = (p1.length === 13 && p1.startsWith('55') && p1[4] === '9')
    ? '55' + p1.substring(2, 4) + p1.substring(5)
    : null;

  // Verifica qual formato do número existe no WhatsApp
  let jid = p1 + '@s.whatsapp.net';
  try {
    const [res1] = await sock.onWhatsApp(p1) || [];
    if (res1?.exists) {
      jid = res1.jid;
      console.log(`[WhatsApp] Número verificado: ${jid}`);
    } else if (p2) {
      const [res2] = await sock.onWhatsApp(p2) || [];
      if (res2?.exists) {
        jid = res2.jid;
        console.log(`[WhatsApp] Número verificado (formato antigo): ${jid}`);
      } else {
        console.warn(`[WhatsApp] ⚠️ Número ${p1} não encontrado no WhatsApp — tentando enviar mesmo assim`);
      }
    }
  } catch (e) {
    console.warn(`[WhatsApp] Não foi possível verificar número ${p1}, enviando direto:`, e.message);
  }

  try {
    await sock.sendMessage(jid, { text: message });
    console.log(`[WhatsApp] ✅ Enviado para ${jid}`);
  } catch (e) {
    console.error(`[WhatsApp] ❌ Erro ao enviar para ${jid}:`, e.message);
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
    const diffMin = (appt - now) / 60000;

    // Lembrete na véspera: entre 23h e 24h antes
    if (!b.sent24h && diffMin >= 23 * 60 && diffMin <= 24 * 60) {
      await sendMsg(b.phone, msgLembreteVespera(b));
      b.sent24h = true;
      changed = true;
      console.log(`[Lembrete 24h] enviado para ${b.name}`);
    }

    // Lembrete 1h antes
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

// ── Rota: QR Code para conectar WhatsApp ──────────────────────
app.get('/qr', async (req, res) => {
  if (isConnected) {
    return res.send(`
      <!DOCTYPE html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>WhatsApp - Gomes Barbearia</title>
      <style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f0f2f5}
      .card{background:#fff;border-radius:16px;padding:40px;max-width:400px;margin:0 auto;box-shadow:0 2px 16px rgba(0,0,0,.1)}
      h2{color:#25D366}p{color:#555}</style></head>
      <body><div class="card">
      <h2>✅ WhatsApp Conectado!</h2>
      <p>O bot está online e enviando mensagens normalmente.</p>
      <p style="font-size:2em">🤖💈</p>
      </div></body></html>
    `);
  }

  if (!currentQR) {
    return res.send(`
      <!DOCTYPE html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>WhatsApp QR - Gomes Barbearia</title>
      <style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f0f2f5}
      .card{background:#fff;border-radius:16px;padding:40px;max-width:400px;margin:0 auto;box-shadow:0 2px 16px rgba(0,0,0,.1)}
      h2{color:#555}p{color:#888}</style></head>
      <body><div class="card">
      <h2>⏳ Gerando QR Code...</h2>
      <p>O bot está iniciando. Aguarde alguns segundos.</p>
      <p>Esta página atualiza automaticamente.</p>
      </div>
      <script>setTimeout(()=>location.reload(),3000);</script>
      </body></html>
    `);
  }

  try {
    const qrImage = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });
    res.send(`
      <!DOCTYPE html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>WhatsApp QR - Gomes Barbearia</title>
      <style>body{font-family:sans-serif;text-align:center;padding:20px;background:#f0f2f5}
      .card{background:#fff;border-radius:16px;padding:30px;max-width:380px;margin:0 auto;box-shadow:0 2px 16px rgba(0,0,0,.1)}
      h2{color:#25D366;margin-bottom:8px}
      p{color:#555;font-size:14px;margin:6px 0}
      img{border:2px solid #eee;border-radius:8px;margin:16px 0}
      .steps{text-align:left;background:#f9f9f9;border-radius:8px;padding:16px;margin-top:16px;font-size:13px}
      .steps li{margin:6px 0;color:#333}</style></head>
      <body><div class="card">
      <h2>📱 Conectar WhatsApp</h2>
      <p>Escaneie o QR Code abaixo com seu celular</p>
      <img src="${qrImage}" width="280" height="280" />
      <div class="steps"><ol>
      <li>Abra o WhatsApp no celular</li>
      <li>Toque em <strong>⋮ Menu → Dispositivos conectados</strong></li>
      <li>Toque em <strong>Conectar dispositivo</strong></li>
      <li>Aponte a câmera para o QR acima</li>
      </ol></div>
      <p style="color:#aaa;font-size:12px;margin-top:16px">Esta página atualiza automaticamente a cada 20s</p>
      </div>
      <script>setTimeout(()=>location.reload(),20000);</script>
      </body></html>
    `);
  } catch (e) {
    res.status(500).send('Erro ao gerar QR: ' + e.message);
  }
});

// ── Rota: status do WhatsApp ──────────────────────────────────
// POST /reset-whatsapp — força limpeza de sessão e novo QR
app.post('/reset-whatsapp', async (req, res) => {
  console.log('[WhatsApp] Reset manual solicitado via /reset-whatsapp');
  isConnected = false;
  currentQR = null;
  if (sock) { try { sock.end(); } catch (e) {} sock = null; }
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
  setTimeout(connectWhatsApp, 1000);
  res.json({ success: true, message: 'Sessão limpa. Acesse /qr em 5 segundos para escanear.' });
});

app.get('/whatsapp-status', (req, res) => {
  res.json({
    connected: isConnected,
    qrAvailable: !!currentQR,
    status: isConnected ? 'online' : (currentQR ? 'aguardando_scan' : 'reconectando')
  });
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
    sent24h: false, sent1h: false, sent10min: false, done: false,
    createdAt: new Date().toISOString()
  };

  const list = loadBookings();
  list.push(booking);
  saveBookings(list);

  await sendMsg(phone, msgConfirmacao(booking));
  await sendMsg(BARBEIRO, msgNovoBarbeiro(booking));

  console.log(`[Agendamento] ${name} - ${service} - ${date} ${time}`);
  res.json({ success: true, message: 'Agendamento confirmado e WhatsApp enviado!' });
});

// ── Rota: listar agendamentos ─────────────────────────────────
app.get('/bookings', (req, res) => {
  res.json(loadBookings());
});

// ── Rotas: horários bloqueados ─────────────────────────────────
app.get('/blocks', (req, res) => {
  const { date } = req.query;
  const blocked = loadBlocked();
  res.json(date ? (blocked[date] || []) : blocked);
});

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

// GET /available?date=YYYY-MM-DD
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

// DELETE /booking/by-slot — cancela + WhatsApp
app.delete('/booking/by-slot', async (req, res) => {
  const { date, slot, phone: fallbackPhone, name: fallbackName, service: fallbackService } = req.body;
  if (!date || !slot) return res.status(400).json({ error: 'date e slot obrigatórios' });
  const localDate = isoToLabel(date);
  const list = loadBookings();
  const booking = list.find(b => b.date === localDate && b.time === slot && !b.done);

  const clientPhone   = booking?.phone   || fallbackPhone;
  const clientName    = booking?.name    || fallbackName  || 'Cliente';
  const clientService = booking?.service || fallbackService || 'Serviço';
  const clientDate    = booking?.date    || localDate;

  if (!clientPhone) {
    return res.json({ success: false, message: 'Telefone do cliente não encontrado — WhatsApp não enviado.' });
  }

  const msg =
    `😔 *Agendamento cancelado*\n\n` +
    `Olá, *${clientName}*! Infelizmente precisamos cancelar seu agendamento.\n\n` +
    `✂️ *Serviço:* ${clientService}\n` +
    `📅 *Data:* ${clientDate}\n` +
    `⏰ *Horário:* ${slot}\n\n` +
    `Entre em contato pelo WhatsApp para reagendar. Pedimos desculpas pelo inconveniente! 🙏`;
  await sendMsg(clientPhone, msg);

  if (booking) {
    saveBookings(list.filter(b => b !== booking));
  }
  console.log(`[Cancel by-slot] ${clientName} ${clientDate} ${slot} (bot booking: ${booking ? 'sim' : 'não'})`);
  res.json({ success: true, message: `${clientName} cancelado e notificado.` });
});

// ── Rota: cancelar agendamento individual ─────────────────────
app.delete('/booking/:id', async (req, res) => {
  const id = Number(req.params.id);
  const list = loadBookings();
  const booking = list.find(b => b.id === id);
  if (!booking) return res.status(404).json({ error: 'Agendamento não encontrado' });

  const msg =
    `😔 *Agendamento cancelado*\n\n` +
    `Olá, *${booking.name}*! Infelizmente precisamos cancelar seu agendamento.\n\n` +
    `✂️ *Serviço:* ${booking.service}\n` +
    `📅 *Data:* ${booking.date}\n` +
    `⏰ *Horário:* ${booking.time}\n\n` +
    `Entre em contato pelo WhatsApp para reagendar. Pedimos desculpas pelo inconveniente! 🙏`;
  await sendMsg(booking.phone, msg);

  saveBookings(list.filter(b => b.id !== id));
  res.json({ success: true, message: `Agendamento de ${booking.name} cancelado e cliente notificado.` });
});

// ── Rota: limpar todos os agendamentos ────────────────────────
app.delete('/bookings', (req, res) => {
  saveBookings([]);
  res.json({ success: true, message: 'Todos os agendamentos foram removidos.' });
});

// ── Rota: status do servidor ──────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    bot: 'Gomes Barbearia Bot',
    whatsapp: isConnected ? 'conectado' : 'desconectado',
    time: new Date().toISOString()
  });
});

// ── Iniciar servidor ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 Bot Gomes Barbearia rodando na porta ${PORT}`);
  console.log(`📱 WhatsApp: acesse /qr para conectar via QR Code`);
});
