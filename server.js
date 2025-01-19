import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST'],
  })
);
app.use(express.json());

app.get('/generate-audio-stream', async (req, res) => {
  const { title, text, voice } = req.query;
  if (!title || !text) {
    res.writeHead(400, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"error": "Title and text are required."}\n\n');
    return res.end();
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();

  try {
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

    res.write(`data: {"status":"Concatenating audio files..."}\n\n`);
    const concatenatedPath = path.join(tmpdir(), `concatenated_${Date.now()}.mp3`);
    await new Promise((resolve, reject) => {
      let command = ffmpeg();
      tempFiles.forEach(file => {
        command = command.input(file);
      });
      command
        .on('error', err => reject(err))
        .on('end', () => resolve())
        .mergeToFile(concatenatedPath, tmpdir());
    });

    const finalBuffer = fs.readFileSync(concatenatedPath);
    const base64Audio = finalBuffer.toString('base64');

    // Clean up temporary files
    tempFiles.forEach(f => fs.unlinkSync(f));
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

app.get('/', (req, res) => {
  res.send('TTS API is ready.');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});