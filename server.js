// server.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawn } from 'child_process';
import OpenAI from 'openai';  // SDK v4 import

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS & JSON parsing
app.use(cors({ origin: '*', methods: ['GET','POST'] }));
app.use(express.json());

// In-memory store for requests
const requests = new Map();

/**
 * 1. POST /initiate-audio-generation
 *    Accepts { title, text, voice, model, instructions }
 *    Returns { requestId }
 */
app.post('/initiate-audio-generation', (req, res) => {
  const { title, text, voice, model, instructions } = req.body;
  if (!title || !text) {
    return res.status(400).json({ error: 'Title and text are required.' });
  }

  const requestId = Date.now().toString() + Math.random().toString(36).substring(2);
  requests.set(requestId, { title, text, voice, model, instructions });
  res.json({ requestId });
});

/**
 * 2. GET /generate-audio-stream?requestId=...
 *    Streams status updates and final base64 MP3 via SSE.
 */
app.get('/generate-audio-stream', async (req, res) => {
  const { requestId } = req.query;
  if (!requestId) {
    res.writeHead(400, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"error":"requestId parameter is required."}\n\n');
    return res.end();
  }

  const stored = requests.get(requestId);
  if (!stored) {
    res.writeHead(404, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"error":"No data found for the given requestId."}\n\n');
    return res.end();
  }
  // Remove from map so it can't be reused
  requests.delete(requestId);

  const { title, text, voice, model, instructions } = stored;

  // Setup SSE headers
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();

  try {
    // 1) Split text into ~4k-character chunks
    res.write(`data: {"status":"Splitting text into chunks..."}\n\n`);
    const chunkSize = 4000;
    const chunks = [];
    for (let i = 0; i < text.length; ) {
      let end = Math.min(i + chunkSize, text.length);
      if (end < text.length) {
        const pi = text.lastIndexOf('.', end);
        if (pi > i) end = pi + 1;
      }
      chunks.push(text.slice(i, end));
      i = end;
    }

    // 2) Generate TTS for each chunk
    const tempFiles = [];
    const ttsModel = model || 'gpt-4o-mini-tts';
    for (let idx = 0; idx < chunks.length; idx++) {
      res.write(
        `data: {"status":"Generating chunk ${idx + 1} of ${chunks.length}..."}\n\n`
      );

      // Build the create parameters, conditionally including instructions
      const params = {
        model: ttsModel,
        voice: voice || 'alloy',
        input: chunks[idx],
        response_format: 'mp3'
      };
      if (instructions && instructions.trim()) {
        params.instructions = instructions.trim();
      }

      // Call the OpenAI TTS endpoint
      const mp3Response = await openai.audio.speech.create(params);
      const arrayBuffer = await mp3Response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Write out a temporary MP3 file
      const tempPath = path.join(tmpdir(), `chunk_${idx}.mp3`);
      fs.writeFileSync(tempPath, buffer);
      tempFiles.push(tempPath);
    }

    // 3) Concatenate via FFmpeg
    res.write(`data: {"status":"Concatenating audio chunks..."}\n\n`);
    const listFile = path.join(tmpdir(), 'filelist.txt');
    fs.writeFileSync(
      listFile,
      tempFiles.map(f => `file '${f}'`).join('\n')
    );
    const outPath = path.join(tmpdir(), `full_${Date.now()}.mp3`);

    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-f','concat','-safe','0','-i', listFile,
        '-c','copy', outPath
      ]);
      ff.stderr.on('data', d => console.error('ffmpeg:', d.toString()));
      ff.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    });

    // Read final MP3, convert to base64
    const finalBuffer = fs.readFileSync(outPath);
    const base64Audio = finalBuffer.toString('base64');

    // Cleanup temp files
    tempFiles.forEach(f => fs.unlinkSync(f));
    fs.unlinkSync(listFile);
    fs.unlinkSync(outPath);

    // 4) Send back the audio
    res.write(`data: {"status":"Audio generated successfully."}\n\n`);
    res.write(
      `data: {"title":"${title}","audioBase64":"${base64Audio}"}\n\n`
    );
    res.end();

  } catch (err) {
    console.error('Error generating audio:', err);
    res.write(`data: {"error":"Failed to generate audio."}\n\n`);
    res.end();
  }
});

/**
 * 3. POST /generate-audio
 *    Non-SSE fallback (not chunked)—implementation omitted for brevity
 */
app.post('/generate-audio', async (req, res) => {
  res.status(501).json({ error: 'Not implemented in this demo.' });
});

// Root health check
app.get('/', (req, res) => res.send('TTS API is ready.'));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});