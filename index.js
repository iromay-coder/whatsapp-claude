const express = require('express');
const axios = require('axios');
const fs = require('fs');
const { exec } = require('child_process');
const FormData = require('form-data');
const app = express();

app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'romay_secret_token';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const conversaciones = {};

// Genera audio con edge-tts y lo convierte a ogg opus
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

// Descarga el audio de WhatsApp
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

// Transcribe audio con Groq Whisper
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

// Sube audio a WhatsApp
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

  const audioPath = await generarAudio(respuesta);
  const mediaId = await subirAudio(audioPath);
  await enviarAudio(from, mediaId);
  fs.unlinkSync(audioPath);

  console.log(`Respuesta enviada a ${from}`);
}

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

    if (message.type === 'text') {
      const texto = message.text.body;
      console.log(`Texto de ${from}: ${texto}`);
      await procesarMensaje(from, texto);

    } else if (message.type === 'audio') {
      console.log(`Audio de ${from}, transcribiendo...`);
      const mediaId = message.audio.id;
      const audioPath = await descargarAudioWhatsApp(mediaId);
      const transcripcion = await transcribirAudio(audioPath);
      fs.unlinkSync(audioPath);
      console.log(`Transcripción: ${transcripcion}`);
      await procesarMensaje(from, transcripcion);
    }

  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
});

app.get('/', (req, res) => res.send('Bot WhatsApp-Claude de ISBEROAL funcionando'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
