// server.js

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
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

app.post('/generate-audio', async (req, res) => {
  try {
    const { title, text, voice } = req.body;
    if (!title || !text) {
      return res.status(400).json({ error: 'Title and text are required.' });
    }

    // Using 4000 characters as chunk size
    const chunkSize = 4000;
    let chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      let end = i + chunkSize;
      if (end < text.length) {
        const punctuationIndex = text.lastIndexOf('.', end);
        if (punctuationIndex > i) {
          end = punctuationIndex + 1;
        }
      }
      chunks.push(text.slice(i, end));
      i = end - 1;
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
