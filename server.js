import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { Configuration, OpenAIApi } from 'openai';

dotenv.config();

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

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

// New endpoint to initiate audio generation and store large text
app.post('/initiate-audio-generation', async (req, res) => {
  const { title, text, voice } = req.body;
  if (!title || !text) {
    return res.status(400).json({ error: 'Title and text are required.' });
  }
  // Generate a unique requestId
  const requestId = Date.now().toString() + Math.random().toString(36).substring(2);
  requests.set(requestId, { title, text, voice });
  res.json({ requestId });
});

// Updated SSE endpoint using requestId
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
  // Optionally remove the request from store after retrieval
  requests.delete(requestId);

  const { title, text, voice } = storedData;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();

  try {
    // 1. Splitting text into chunks
    res.write(`data: {"status":"Splitting text into chunks..."}\n\n`);
    const chunkSize = 4000;
    let chunks = [];
    let start = 0;
    while (start < text.length) {
      let end = start + chunkSize;
      if (end < text.length) {
        const punctuationIndex = text.lastIndexOf('.', end);
        if (punctuationIndex > start) {
          end = punctuationIndex + 1;
        }
      }
      chunks.push(text.slice(start, end));
      start = end;
    }

    // 2. Generating audio for each chunk
    let tempFiles = [];
    for (let i = 0; i < chunks.length; i++) {
      res.write(`data: {"status":"Generating audio for chunk ${i + 1} of ${chunks.length}"}\n\n`);
      const chunk = chunks[i];
      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: 'tts-1',
          voice: voice || 'alloy',
          input: chunk
        })
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const tempPath = path.join(tmpdir(), `chunk_${i}.mp3`);
      fs.writeFileSync(tempPath, buffer);
      tempFiles.push(tempPath);
    }

    // 3. Concatenating audio files without re-encoding
    res.write(`data: {"status":"Concatenating audio files..."}\n\n`);
    const fileListPath = path.join(tmpdir(), 'filelist.txt');
    const listContent = tempFiles.map(file => `file '${file}'`).join('\n');
    fs.writeFileSync(fileListPath, listContent);

    const concatenatedPath = path.join(tmpdir(), `concatenated_${Date.now()}.mp3`);

    await new Promise((resolve, reject) => {
      const ffmpegProcess = spawn('ffmpeg', [
        '-f', 'concat',
        '-safe', '0',
        '-i', fileListPath,
        '-c', 'copy',
        concatenatedPath
      ]);

      ffmpegProcess.stderr.on('data', data => {
        console.error(`ffmpeg stderr: ${data}`);
      });

      ffmpegProcess.on('close', code => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg process exited with code ${code}`));
        }
      });
    });

    const finalBuffer = fs.readFileSync(concatenatedPath);
    const base64Audio = finalBuffer.toString('base64');

    // 4. Cleaning up temporary files
    tempFiles.forEach(f => fs.unlinkSync(f));
    fs.unlinkSync(fileListPath);
    fs.unlinkSync(concatenatedPath);

    res.write(`data: {"status":"Audio generated successfully."}\n\n`);
    res.write(`data: {"title": "${title}", "audioBase64": "${base64Audio}"}\n\n`);
    res.end();
  } catch (error) {
    console.error('Error generating audio:', error);
    res.write(`data: {"error": "Failed to generate audio."}\n\n`);
    res.end();
  }
});

// Existing non-streaming endpoint remains unchanged
app.post('/generate-audio', async (req, res) => {
  try {
    const { title, text, voice } = req.body;
    if (!title || !text) {
      return res.status(400).json({ error: 'Title and text are required.' });
    }

    const chunkSize = 4000;
    let chunks = [];
    let start = 0;
    while (start < text.length) {
      let end = start + chunkSize;
      if (end < text.length) {
        const punctuationIndex = text.lastIndexOf('.', end);
        if (punctuationIndex > start) {
          end = punctuationIndex + 1;
        }
      }
      chunks.push(text.slice(start, end));
      start = end;
    }

    let tempFiles = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: 'tts-1',
          voice: voice || 'alloy',
          input: chunk
        })
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const tempPath = path.join(tmpdir(), `chunk_${i}.mp3`);
      fs.writeFileSync(tempPath, buffer);
      tempFiles.push(tempPath);
    }

    const fileListPath = path.join(tmpdir(), 'filelist.txt');
    const listContent = tempFiles.map(file => `file '${file}'`).join('\n');
    fs.writeFileSync(fileListPath, listContent);

    const concatenatedPath = path.join(tmpdir(), `concatenated_${Date.now()}.mp3`);
    // For non-streaming endpoint, using execSync is still acceptable
    require('child_process').execSync(`ffmpeg -f concat -safe 0 -i ${fileListPath} -c copy ${concatenatedPath}`);

    const finalBuffer = fs.readFileSync(concatenatedPath);
    const base64Audio = finalBuffer.toString('base64');

    tempFiles.forEach(f => fs.unlinkSync(f));
    fs.unlinkSync(fileListPath);
    fs.unlinkSync(concatenatedPath);

    res.status(200).json({ 
      message: 'Audio generated successfully.', 
      title, 
      audioBase64: base64Audio 
    });
  } catch (error) {
    console.error('Error generating audio:', error);
    res.status(500).json({ error: 'Failed to generate audio.' });
  }
});

app.get('/', (req, res) => {
  res.send('TTS API is ready.');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});