const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const FormData = require('form-data');
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

const conversaciones = {};
const devSessions = {};
const pendingApprovals = {};

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
        system: `Eres Claude Code, el asistente de programación personal de Ismael Romay, director de ISBEROAL. Tienes acceso a herramientas para leer y modificar el código del bot de WhatsApp que corre en Railway. El código está en /app. Cuando modifiques archivos, usa siempre git_push después para que Railway redespliegue automáticamente. Responde siempre en español. Sé conciso: ve al grano, no des explicaciones innecesarias.`,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
