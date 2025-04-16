// server.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawn, execSync } from 'child_process';
import OpenAI from 'openai';  // <-- SDK v4 import

dotenv.config();

// Instantiate the OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST'],
  })
);
app.use(express.json());

// In-memory store for requests
const requests = new Map();

/**
 * 1. POST /initiate-audio-generation
 *    - Accepts { title, text, voice, model } and returns { requestId }
 */
app.post('/initiate-audio-generation', (req, res) => {
  const { title, text, voice, model } = req.body;
  if (!title || !text) {
    return res.status(400).json({ error: 'Title and text are required.' });
  }

  const requestId = Date.now().toString() + Math.random().toString(36).substring(2);
  requests.set(requestId, { title, text, voice, model });
  res.json({ requestId });
});

/**
 * 2. GET /generate-audio-stream?requestId=...
 *    - Splits text, calls OpenAI TTS per chunk via SDK, concatenates with FFmpeg,
 *      and streams status + final base64 audio via SSE.
 */
app.get('/generate-audio-stream', async (req, res) => {
  const { requestId } = req.query;
  if (!requestId) {
    res.writeHead(400, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"error": "requestId parameter is required."}\n\n');
    return res.end();
  }

  const storedData = requests.get(requestId);
  if (!storedData) {
    res.writeHead(404, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"error": "No data found for the given requestId."}\n\n');
    return res.end();
  }
  requests.delete(requestId);

  const { title, text, voice, model } = storedData;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();

  try {
    // 1) Chunk the text at ~4000 chars, breaking at punctuation when possible
    res.write(`data: {"status":"Splitting text into chunks..."}\n\n`);
    const chunkSize = 4000;
    const chunks = [];
    for (let start = 0; start < text.length; ) {
      let end = Math.min(start + chunkSize, text.length);
      if (end < text.length) {
        const pi = text.lastIndexOf('.', end);
        if (pi > start) end = pi + 1;
      }
      chunks.push(text.slice(start, end));
      start = end;
    }

    // 2) Generate audio chunk-by-chunk
    const tempFiles = [];
    for (let i = 0; i < chunks.length; i++) {
      res.write(`data: {"status":"Generating audio for chunk ${i + 1} of ${chunks.length}"}\n\n`);

      const ttsModel = model || 'gpt-4o-mini-tts';
      const mp3Response = await openai.audio.speech.create({
        model: ttsModel,
        voice: voice || 'alloy',
        input: chunks[i],
        response_format: 'mp3'
      });

      // Convert streamed MP3 to Buffer
      const arrayBuffer = await mp3Response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const tempPath = path.join(tmpdir(), `chunk_${i}.mp3`);
      fs.writeFileSync(tempPath, buffer);
      tempFiles.push(tempPath);
    }

    // 3) Concatenate MP3 chunks with FFmpeg
    res.write(`data: {"status":"Concatenating audio files..."}\n\n`);
    const fileListPath = path.join(tmpdir(), 'filelist.txt');
    fs.writeFileSync(fileListPath, tempFiles.map(f => `file '${f}'`).join('\n'));

    const concatenatedPath = path.join(tmpdir(), `concatenated_${Date.now()}.mp3`);
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-f','concat','-safe','0','-i',fileListPath,'-c','copy',concatenatedPath
      ]);
      proc.stderr.on('data', d => console.error(`ffmpeg: ${d}`));
      proc.on('close', code => code===0 ? resolve() : reject(new Error(`ffmpeg ${code}`)));
    });

    const finalBuffer = fs.readFileSync(concatenatedPath);
    const base64Audio = finalBuffer.toString('base64');

    // Cleanup
    tempFiles.forEach(f => fs.unlinkSync(f));
    fs.unlinkSync(fileListPath);
    fs.unlinkSync(concatenatedPath);

    // 4) Send final audio
    res.write(`data: {"status":"Audio generated successfully."}\n\n`);
    res.write(`data: {"title":"${title}","audioBase64":"${base64Audio}"}\n\n`);
    res.end();

  } catch (err) {
    console.error('Error generating audio:', err);
    res.write(`data: {"error":"Failed to generate audio."}\n\n`);
    return res.end();
  }
});

/**
 * 3. POST /generate-audio
 *    - Non-SSE version for smaller texts
 */
app.post('/generate-audio', async (req, res) => {
  try {
    const { title, text, voice, model } = req.body;
    if (!title || !text) {
      return res.status(400).json({ error: 'Title and text are required.' });
    }

    // Same chunking logic...
    // (omitted for brevity; implement as above)

    res.status(200).json({
      message: 'Audio generated successfully.',
      title,
      audioBase64: finalBase64  // from concatenation above
    });
  } catch (error) {
    console.error('Error generating audio:', error);
    res.status(500).json({ error: 'Failed to generate audio.' });
  }
});

// Root health check
app.get('/', (req, res) => res.send('TTS API is ready.'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
