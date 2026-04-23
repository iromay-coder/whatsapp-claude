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

// Historial de conversación por usuario
const conversaciones = {};

// Genera audio con edge-tts y lo convierte a ogg opus
function generarAudio(texto) {
  return new Promise((resolve, reject) => {
    const tmpMp3 = `/tmp/audio_${Date.now()}.mp3`;
    const tmpOgg = `/tmp/audio_${Date.now()}.ogg`;
    const cmd = `edge-tts --voice es-ES-AlvaroNeural --text "${texto.replace(/"/g, "'")}" --write-media ${tmpMp3} && ffmpeg -i ${tmpMp3} -c:a libopus -b:a 64k ${tmpOgg} -y && rm ${tmpMp3}`;
    exec(cmd, (error) => {
      if (error) return reject(error);
      resolve(tmpOgg);
    });
  });
}

// Sube el audio a WhatsApp y devuelve el media_id
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

// Envía mensaje de texto
async function enviarTexto(to, texto) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: texto } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

// Envía nota de voz (se reproduce automáticamente)
async function enviarAudio(to, mediaId) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'audio', audio: { id: mediaId } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

// Verificación del webhook de Meta
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Recibir mensajes de WhatsApp
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message || message.type !== 'text') return;

    const from = message.from;
    const text = message.text.body;
    console.log(`Mensaje de ${from}: ${text}`);

    if (!conversaciones[from]) conversaciones[from] = [];

    conversaciones[from].push({ role: 'user', content: text });

    // Llamar a Claude
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

    // Enviar texto
    await enviarTexto(from, respuesta);

    // Generar y enviar audio
    const audioPath = await generarAudio(respuesta);
    const mediaId = await subirAudio(audioPath);
    await enviarAudio(from, mediaId);
    fs.unlinkSync(audioPath);

    console.log(`Respuesta enviada a ${from}`);
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
});

app.get('/', (req, res) => res.send('Bot WhatsApp-Claude de ISBEROAL funcionando'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
