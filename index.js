const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const FormData = require('form-data');
const { google } = require('googleapis');
const app = express();

app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'romay_secret_token';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'iromay-coder/whatsapp-claude';
const ISMAEL_NUMBER = process.env.ISMAEL_NUMBER || '34610870338';
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY;

const conversaciones = {};
const devSessions = {};
const pendingApprovals = {};

// ─── Google Auth ──────────────────────────────────────────────────────────────

function getGoogleAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return oauth2Client;
}

// ─── Audio ────────────────────────────────────────────────────────────────────

function generarAudio(texto) {
  return new Promise((resolve, reject) => {
    const ts = Date.now();
    const tmpMp3 = `/tmp/audio_${ts}.mp3`;
    const tmpOgg = `/tmp/audio_${ts}.ogg`;
    const cmd = `edge-tts --voice es-ES-AlvaroNeural --text "${texto.replace(/"/g, "'")}" --write-media ${tmpMp3} && ffmpeg -i ${tmpMp3} -c:a libopus -b:a 64k ${tmpOgg} -y && rm ${tmpMp3}`;
    exec(cmd, (error) => {
      if (error) return reject(error);
      resolve(tmpOgg);
    });
  });
}

async function descargarAudioWhatsApp(mediaId) {
  const urlResp = await axios.get(
    `https://graph.facebook.com/v18.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
  const mediaUrl = urlResp.data.url;
  const audioResp = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
  });
  const filePath = `/tmp/input_${Date.now()}.ogg`;
  fs.writeFileSync(filePath, audioResp.data);
  return filePath;
}

async function transcribirAudio(filePath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), { filename: 'audio.ogg', contentType: 'audio/ogg' });
  form.append('model', 'whisper-large-v3');
  form.append('language', 'es');
  const resp = await axios.post(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    form,
    { headers: { ...form.getHeaders(), Authorization: `Bearer ${GROQ_API_KEY}` } }
  );
  return resp.data.text;
}

async function subirAudio(filePath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), { contentType: 'audio/ogg', filename: 'audio.ogg' });
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'audio/ogg');
  const response = await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/media`,
    form,
    { headers: { ...form.getHeaders(), Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
  return response.data.id;
}

async function enviarTexto(to, texto) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: texto } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

async function enviarAudio(to, mediaId) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'audio', audio: { id: mediaId } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

// ─── Chat normal ──────────────────────────────────────────────────────────────

async function procesarMensaje(from, texto) {
  if (!conversaciones[from]) conversaciones[from] = [];
  conversaciones[from].push({ role: 'user', content: texto });

  const claudeResponse = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      system: 'Eres un asistente de ISBEROAL, empresa de energía renovable en Galicia. Responde siempre en el idioma del usuario, de forma concisa y útil.',
      messages: conversaciones[from]
    },
    {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      }
    }
  );

  const respuesta = claudeResponse.data.content[0].text;
  conversaciones[from].push({ role: 'assistant', content: respuesta });
  if (conversaciones[from].length > 20) conversaciones[from] = conversaciones[from].slice(-20);

  await enviarTexto(from, respuesta);

  try {
    const audioPath = await generarAudio(respuesta);
    const mediaId = await subirAudio(audioPath);
    await enviarAudio(from, mediaId);
    fs.unlinkSync(audioPath);
  } catch (e) {
    console.error('Error generando audio:', e.message);
  }

  console.log(`Respuesta enviada a ${from}`);
}

// ─── Claude Code mode ─────────────────────────────────────────────────────────

const CLAUDE_CODE_TOOLS = [
  {
    name: 'read_file',
    description: 'Lee el contenido de un archivo del bot',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta del archivo, ej: index.js' }
      },
      required: ['path']
    }
  },
  {
    name: 'list_files',
    description: 'Lista los archivos en un directorio del bot',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Directorio a listar, por defecto raíz del proyecto' }
      }
    }
  },
  {
    name: 'write_file',
    description: 'Escribe o modifica un archivo (pide confirmación al usuario antes de ejecutar)',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta del archivo, ej: index.js' },
        content: { type: 'string', description: 'Contenido completo del archivo' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'execute_bash',
    description: 'Ejecuta un comando bash (pide confirmación al usuario antes de ejecutar)',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Comando bash a ejecutar' }
      },
      required: ['command']
    }
  },
  {
    name: 'git_push',
    description: 'Sube los archivos modificados a GitHub para que Railway redespliegue el bot automáticamente (pide confirmación)',
    input_schema: {
      type: 'object',
      properties: {
        commit_message: { type: 'string', description: 'Mensaje del commit' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lista de archivos modificados a subir, ej: ["index.js"]'
        }
      },
      required: ['commit_message', 'files']
    }
  },
  {
    name: 'gmail_buscar',
    description: 'Busca emails en Gmail de Ismael',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Búsqueda Gmail, ej: "from:cliente@empresa.com" o "subject:factura"' },
        max: { type: 'number', description: 'Máximo de resultados, por defecto 5' }
      },
      required: ['query']
    }
  },
  {
    name: 'gmail_leer',
    description: 'Lee el contenido completo de un email por su ID',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID del mensaje de Gmail' }
      },
      required: ['id']
    }
  },
  {
    name: 'gmail_enviar',
    description: 'Envía un email desde la cuenta de Ismael (pide confirmación)',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Destinatario' },
        subject: { type: 'string', description: 'Asunto' },
        body: { type: 'string', description: 'Cuerpo del email' }
      },
      required: ['to', 'subject', 'body']
    }
  },
  {
    name: 'calendar_listar',
    description: 'Lista los próximos eventos del calendario de Ismael',
    input_schema: {
      type: 'object',
      properties: {
        dias: { type: 'number', description: 'Cuántos días hacia adelante mirar, por defecto 7' }
      }
    }
  },
  {
    name: 'calendar_crear',
    description: 'Crea un evento en el calendario de Ismael (pide confirmación)',
    input_schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string', description: 'Título del evento' },
        inicio: { type: 'string', description: 'Fecha y hora de inicio en formato ISO, ej: 2026-04-25T10:00:00' },
        fin: { type: 'string', description: 'Fecha y hora de fin en formato ISO' },
        descripcion: { type: 'string', description: 'Descripción opcional' }
      },
      required: ['titulo', 'inicio', 'fin']
    }
  },
  {
    name: 'drive_buscar',
    description: 'Busca archivos en Google Drive de Ismael',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto a buscar en el nombre del archivo' },
        max: { type: 'number', description: 'Máximo de resultados, por defecto 5' }
      },
      required: ['query']
    }
  },
  {
    name: 'drive_leer',
    description: 'Lee el contenido de un archivo de Google Drive (documentos de texto)',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID del archivo en Drive' }
      },
      required: ['id']
    }
  },
  {
    name: 'maps_buscar',
    description: 'Busca un lugar en Google Maps',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Nombre o dirección del lugar' }
      },
      required: ['query']
    }
  },
  {
    name: 'maps_ruta',
    description: 'Calcula la ruta entre dos lugares',
    input_schema: {
      type: 'object',
      properties: {
        origen: { type: 'string', description: 'Lugar de origen' },
        destino: { type: 'string', description: 'Lugar de destino' },
        modo: { type: 'string', description: 'Modo de transporte: driving, walking, transit. Por defecto driving' }
      },
      required: ['origen', 'destino']
    }
  },
  {
    name: 'maps_cercanos',
    description: 'Busca lugares cercanos a una ubicación',
    input_schema: {
      type: 'object',
      properties: {
        ubicacion: { type: 'string', description: 'Dirección o coordenadas del centro de búsqueda' },
        tipo: { type: 'string', description: 'Tipo de lugar: restaurant, gas_station, hospital, etc.' },
        radio: { type: 'number', description: 'Radio de búsqueda en metros, por defecto 1000' }
      },
      required: ['ubicacion', 'tipo']
    }
  }
];

async function pedirAprobacion(from, descripcion) {
  await enviarTexto(from, `⚠️ *Confirmación requerida*\n\n${descripcion}\n\nResponde *SI* para confirmar o *NO* para cancelar.`);
  return new Promise(resolve => {
    pendingApprovals[from] = { resolve };
  });
}

async function githubGetFileSha(filePath) {
  try {
    const resp = await axios.get(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
    );
    return resp.data.sha;
  } catch (e) {
    return null; // File doesn't exist yet
  }
}

async function githubPushFile(filePath, content, commitMessage) {
  const sha = await githubGetFileSha(filePath);
  const body = {
    message: commitMessage,
    content: Buffer.from(content).toString('base64')
  };
  if (sha) body.sha = sha;

  await axios.put(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`,
    body,
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
  );
}

async function ejecutarHerramienta(from, toolName, toolInput) {
  const NEEDS_APPROVAL = ['write_file', 'execute_bash', 'git_push'];

  if (NEEDS_APPROVAL.includes(toolName)) {
    let descripcion = '';
    if (toolName === 'write_file') {
      descripcion = `📝 *Modificar archivo:* \`${toolInput.path}\`\n\nPrimeras líneas:\n\`\`\`\n${toolInput.content.slice(0, 300)}...\`\`\``;
    } else if (toolName === 'execute_bash') {
      descripcion = `💻 *Ejecutar comando:*\n\`\`\`\n${toolInput.command}\n\`\`\``;
    } else if (toolName === 'git_push') {
      descripcion = `🚀 *Git push a GitHub*\nCommit: "${toolInput.commit_message}"\nArchivos: ${toolInput.files.join(', ')}\n\n_Railway redesplegar el bot automáticamente._`;
    }

    const aprobado = await pedirAprobacion(from, descripcion);
    if (!aprobado) {
      return '❌ Acción cancelada por el usuario.';
    }
  }

  try {
    if (toolName === 'read_file') {
      const filePath = path.join('/app', toolInput.path);
      if (!fs.existsSync(filePath)) return `Error: archivo ${toolInput.path} no encontrado.`;
      return fs.readFileSync(filePath, 'utf8');
    }

    if (toolName === 'list_files') {
      const dir = path.join('/app', toolInput.directory || '');
      const files = fs.readdirSync(dir);
      return files.join('\n');
    }

    if (toolName === 'write_file') {
      const filePath = path.join('/app', toolInput.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, toolInput.content, 'utf8');
      return `✅ Archivo ${toolInput.path} escrito localmente.`;
    }

    if (toolName === 'execute_bash') {
      return new Promise((resolve) => {
        exec(toolInput.command, { cwd: '/app', timeout: 30000 }, (error, stdout, stderr) => {
          if (error) resolve(`Error: ${error.message}\n${stderr}`);
          else resolve(stdout || '(sin salida)');
        });
      });
    }

    if (toolName === 'git_push') {
      if (!GITHUB_TOKEN) return 'Error: GITHUB_TOKEN no configurado en Railway.';
      const results = [];
      for (const file of toolInput.files) {
        const filePath = path.join('/app', file);
        if (!fs.existsSync(filePath)) {
          results.push(`⚠️ ${file}: no encontrado localmente.`);
          continue;
        }
        const content = fs.readFileSync(filePath, 'utf8');
        await githubPushFile(file, content, toolInput.commit_message);
        results.push(`✅ ${file} subido.`);
      }
      return `Push completado. Railway redesplegar en ~2 minutos.\n${results.join('\n')}`;
    }

    // ── Google tools ──────────────────────────────────────────────────────────

    if (toolName === 'gmail_buscar') {
      const auth = getGoogleAuth();
      const gmail = google.gmail({ version: 'v1', auth });
      const res = await gmail.users.messages.list({
        userId: 'me',
        q: toolInput.query,
        maxResults: toolInput.max || 5
      });
      if (!res.data.messages || res.data.messages.length === 0) return 'No se encontraron emails.';
      const detalles = await Promise.all(res.data.messages.map(async m => {
        const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
        const headers = msg.data.payload.headers;
        const get = name => headers.find(h => h.name === name)?.value || '';
        return `ID: ${m.id}\nDe: ${get('From')}\nAsunto: ${get('Subject')}\nFecha: ${get('Date')}`;
      }));
      return detalles.join('\n\n');
    }

    if (toolName === 'gmail_leer') {
      const auth = getGoogleAuth();
      const gmail = google.gmail({ version: 'v1', auth });
      const msg = await gmail.users.messages.get({ userId: 'me', id: toolInput.id, format: 'full' });
      const headers = msg.data.payload.headers;
      const get = name => headers.find(h => h.name === name)?.value || '';
      let body = '';
      const parts = msg.data.payload.parts || [msg.data.payload];
      for (const part of parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          body = Buffer.from(part.body.data, 'base64').toString('utf8');
          break;
        }
      }
      return `De: ${get('From')}\nAsunto: ${get('Subject')}\nFecha: ${get('Date')}\n\n${body.slice(0, 2000)}`;
    }

    if (toolName === 'gmail_enviar') {
      const auth = getGoogleAuth();
      const gmail = google.gmail({ version: 'v1', auth });
      const mensaje = [`To: ${toolInput.to}`, `Subject: ${toolInput.subject}`, 'Content-Type: text/plain; charset=utf-8', '', toolInput.body].join('\n');
      const encoded = Buffer.from(mensaje).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
      return `✅ Email enviado a ${toolInput.to}`;
    }

    if (toolName === 'calendar_listar') {
      const auth = getGoogleAuth();
      const calendar = google.calendar({ version: 'v3', auth });
      const ahora = new Date();
      const fin = new Date();
      fin.setDate(fin.getDate() + (toolInput.dias || 7));
      const res = await calendar.events.list({
        calendarId: 'primary',
        timeMin: ahora.toISOString(),
        timeMax: fin.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 10
      });
      if (!res.data.items || res.data.items.length === 0) return 'No hay eventos próximos.';
      return res.data.items.map(e => {
        const start = e.start.dateTime || e.start.date;
        return `📅 ${e.summary}\n   ${start}${e.location ? '\n   📍 ' + e.location : ''}`;
      }).join('\n\n');
    }

    if (toolName === 'calendar_crear') {
      const auth = getGoogleAuth();
      const calendar = google.calendar({ version: 'v3', auth });
      await calendar.events.insert({
        calendarId: 'primary',
        requestBody: {
          summary: toolInput.titulo,
          description: toolInput.descripcion || '',
          start: { dateTime: toolInput.inicio, timeZone: 'Europe/Madrid' },
          end: { dateTime: toolInput.fin, timeZone: 'Europe/Madrid' }
        }
      });
      return `✅ Evento "${toolInput.titulo}" creado en el calendario.`;
    }

    if (toolName === 'drive_buscar') {
      const auth = getGoogleAuth();
      const drive = google.drive({ version: 'v3', auth });
      const res = await drive.files.list({
        q: `name contains '${toolInput.query}' and trashed = false`,
        fields: 'files(id, name, mimeType, modifiedTime)',
        pageSize: toolInput.max || 5
      });
      if (!res.data.files || res.data.files.length === 0) return 'No se encontraron archivos.';
      return res.data.files.map(f => `📄 ${f.name}\n   ID: ${f.id}\n   Tipo: ${f.mimeType}\n   Modificado: ${f.modifiedTime}`).join('\n\n');
    }

    if (toolName === 'drive_leer') {
      const auth = getGoogleAuth();
      const drive = google.drive({ version: 'v3', auth });
      try {
        const res = await drive.files.export({ fileId: toolInput.id, mimeType: 'text/plain' }, { responseType: 'text' });
        return String(res.data).slice(0, 3000);
      } catch {
        const res = await drive.files.get({ fileId: toolInput.id, alt: 'media' }, { responseType: 'text' });
        return String(res.data).slice(0, 3000);
      }
    }

    // ── Google Maps ───────────────────────────────────────────────────────────

    if (toolName === 'maps_buscar') {
      if (!GOOGLE_MAPS_KEY) return 'Error: GOOGLE_MAPS_KEY no configurado.';
      const res = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
        params: { query: toolInput.query, key: GOOGLE_MAPS_KEY, language: 'es' }
      });
      if (!res.data.results.length) return 'No se encontraron resultados.';
      return res.data.results.slice(0, 3).map(p =>
        `📍 ${p.name}\n   ${p.formatted_address}\n   ⭐ ${p.rating || 'sin valoración'}`
      ).join('\n\n');
    }

    if (toolName === 'maps_ruta') {
      if (!GOOGLE_MAPS_KEY) return 'Error: GOOGLE_MAPS_KEY no configurado.';
      const res = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
        params: {
          origin: toolInput.origen,
          destination: toolInput.destino,
          mode: toolInput.modo || 'driving',
          key: GOOGLE_MAPS_KEY,
          language: 'es'
        }
      });
      if (!res.data.routes.length) return 'No se encontró ruta.';
      const ruta = res.data.routes[0].legs[0];
      return `🗺️ ${toolInput.origen} → ${toolInput.destino}\n⏱️ ${ruta.duration.text}\n📏 ${ruta.distance.text}\n\nPasos:\n${ruta.steps.slice(0, 5).map(s => `• ${s.html_instructions.replace(/<[^>]+>/g, '')}`).join('\n')}`;
    }

    if (toolName === 'maps_cercanos') {
      if (!GOOGLE_MAPS_KEY) return 'Error: GOOGLE_MAPS_KEY no configurado.';
      const geocode = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
        params: { address: toolInput.ubicacion, key: GOOGLE_MAPS_KEY }
      });
      if (!geocode.data.results.length) return 'No se pudo geolocalizar la ubicación.';
      const loc = geocode.data.results[0].geometry.location;
      const res = await axios.get('https://maps.googleapis.com/maps/api/place/nearbysearch/json', {
        params: {
          location: `${loc.lat},${loc.lng}`,
          radius: toolInput.radio || 1000,
          type: toolInput.tipo,
          key: GOOGLE_MAPS_KEY,
          language: 'es'
        }
      });
      if (!res.data.results.length) return 'No se encontraron lugares cercanos.';
      return res.data.results.slice(0, 5).map(p =>
        `📍 ${p.name}\n   ${p.vicinity}\n   ⭐ ${p.rating || 'sin valoración'}`
      ).join('\n\n');
    }

  } catch (e) {
    return `Error en ${toolName}: ${e.message}`;
  }
}

async function procesarCodigoMensaje(from, texto) {
  if (!devSessions[from]) devSessions[from] = [];
  devSessions[from].push({ role: 'user', content: texto });

  await enviarTexto(from, '🤖 Claude Code procesando...');

  let iterations = 0;
  const MAX_ITERATIONS = 15;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-opus-4-5',
        max_tokens: 4096,
        system: `Eres el asistente personal de Ismael Romay, director de ISBEROAL (empresa de energía renovable en Galicia). Tienes acceso a herramientas para: (1) leer y modificar el código del bot de WhatsApp en /app y redesplegar vía git_push, (2) Gmail: buscar, leer y enviar emails, (3) Google Calendar: ver y crear eventos, (4) Google Drive: buscar y leer archivos. Usa las herramientas de forma autónoma para responder a lo que Ismael necesite. Responde siempre en español. Sé conciso y directo.`,
        tools: CLAUDE_CODE_TOOLS,
        messages: devSessions[from]
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        }
      }
    );

    const content = response.data.content;
    devSessions[from].push({ role: 'assistant', content });

    // Send text parts
    for (const part of content.filter(c => c.type === 'text')) {
      if (part.text.trim()) await enviarTexto(from, part.text);
    }

    if (response.data.stop_reason === 'end_turn') break;

    if (response.data.stop_reason === 'tool_use') {
      const toolUses = content.filter(c => c.type === 'tool_use');
      const toolResults = [];

      for (const toolUse of toolUses) {
        console.log(`Tool: ${toolUse.name}`, toolUse.input);
        const result = await ejecutarHerramienta(from, toolUse.name, toolUse.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: String(result)
        });
      }

      devSessions[from].push({ role: 'user', content: toolResults });
    }
  }

  if (devSessions[from].length > 40) devSessions[from] = devSessions[from].slice(-30);
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    const isIsmael = from === ISMAEL_NUMBER;

    // ── Respuesta a confirmación pendiente ──
    if (message.type === 'text' && pendingApprovals[from]) {
      const txt = message.text.body.trim().toUpperCase();
      if (txt === 'SI' || txt === 'SÍ' || txt === 'S') {
        pendingApprovals[from].resolve(true);
        delete pendingApprovals[from];
        return;
      } else if (txt === 'NO' || txt === 'N') {
        pendingApprovals[from].resolve(false);
        delete pendingApprovals[from];
        return;
      }
    }

    // ── Comando /reset (borra sesión de código) ──
    if (message.type === 'text' && message.text.body.trim() === '/reset') {
      delete devSessions[from];
      delete conversaciones[from];
      await enviarTexto(from, '✅ Sesión reiniciada.');
      return;
    }

    // ── Procesar mensaje ──
    if (message.type === 'text') {
      const texto = message.text.body;
      console.log(`Texto de ${from}: ${texto}`);

      if (isIsmael) {
        await procesarCodigoMensaje(from, texto);
      } else {
        await procesarMensaje(from, texto);
      }

    } else if (message.type === 'audio') {
      console.log(`Audio de ${from}, transcribiendo...`);
      const mediaId = message.audio.id;
      const audioPath = await descargarAudioWhatsApp(mediaId);
      const transcripcion = await transcribirAudio(audioPath);
      fs.unlinkSync(audioPath);
      console.log(`Transcripción: ${transcripcion}`);

      if (isIsmael) {
        await enviarTexto(from, `🎙️ _Transcripción: "${transcripcion}"_`);
        await procesarCodigoMensaje(from, transcripcion);
      } else {
        await procesarMensaje(from, transcripcion);
      }
    }

  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
});

app.get('/', (req, res) => res.send('Bot WhatsApp-Claude de ISBEROAL funcionando'));

// ─── Memoria diaria en Drive ──────────────────────────────────────────────────

async function guardarMemoriaEnDrive() {
  try {
    const auth = getGoogleAuth();
    const drive = google.drive({ version: 'v3', auth });
    const fecha = new Date().toISOString().split('T')[0];
    const contenido = JSON.stringify({ fecha, sesiones: devSessions, conversaciones }, null, 2);
    const nombreArchivo = `romay_bot_memoria_${fecha}.json`;

    // Buscar si ya existe
    const busqueda = await drive.files.list({
      q: `name = '${nombreArchivo}' and trashed = false`,
      fields: 'files(id)'
    });

    if (busqueda.data.files.length > 0) {
      await drive.files.update({
        fileId: busqueda.data.files[0].id,
        media: { mimeType: 'application/json', body: contenido }
      });
    } else {
      await drive.files.create({
        requestBody: { name: nombreArchivo, mimeType: 'application/json' },
        media: { mimeType: 'application/json', body: contenido }
      });
    }
    console.log(`Memoria guardada en Drive: ${nombreArchivo}`);
  } catch (e) {
    console.error('Error guardando memoria en Drive:', e.message);
  }
}

// ─── Mensajes programados ─────────────────────────────────────────────────────

function programarMensajes() {
  // Cada hora comprueba si toca enviar mensaje
  setInterval(async () => {
    const ahora = new Date();
    const hora = ahora.toLocaleString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });
    const [h, m] = hora.split(':').map(Number);

    // Buenos días a las 8:00
    if (h === 8 && m === 0) {
      await enviarTexto(ISMAEL_NUMBER, '☀️ *Buenos días Ismael.* ¿Qué hacemos hoy?');
    }

    // Backup de memoria a medianoche
    if (h === 0 && m === 0) {
      await guardarMemoriaEnDrive();
    }
  }, 60 * 1000); // cada minuto
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  programarMensajes();
  // Mensaje de buenas noches al arrancar (primera vez)
  try {
    await enviarTexto(ISMAEL_NUMBER, '🌙 Bot actualizado y listo. Mañana a las 8 te escribo. Buenas noches Ismael.');
  } catch (e) {
    console.error('Error enviando mensaje de inicio:', e.message);
  }
});
