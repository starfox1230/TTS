// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import { tmpdir } from "os";
import path from "path";
import { spawn } from "child_process";
import multer from "multer";
import OpenAI from "openai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// CORS + JSON
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "2mb" })); // JSON body is small (we return audio bytes, not base64)

// Multer for uploads (concat endpoint)
const upload = multer({ storage: multer.memoryStorage() });

app.get("/", (req, res) => res.send("TTS API is ready."));

/**
 * POST /tts-chunk
 * Body: { text, model, voice, instructions }
 * Returns: audio/mpeg bytes
 */
app.post("/tts-chunk", async (req, res) => {
  try {
    const { text, model, voice, instructions } = req.body || {};
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "text is required" });
    }

    const ttsModel = model || "gpt-4o-mini-tts";
    const ttsVoice = voice || "alloy";

    // OpenAI speech supports mp3/wav/etc; mp3 is smallest
    const params = {
      model: ttsModel,
      voice: ttsVoice,
      input: text,
      response_format: "mp3",
    };

    // instructions is supported on gpt-4o-mini-tts, not tts-1 / tts-1-hd
    if (ttsModel === "gpt-4o-mini-tts" && instructions && instructions.trim()) {
      params.instructions = instructions.trim();
    }

    const mp3Response = await openai.audio.speech.create(params);
    const arrayBuffer = await mp3Response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(buffer);
  } catch (err) {
    console.error("TTS chunk error:", err);
    return res.status(500).json({ error: "Failed to generate chunk audio" });
  }
});

/**
 * POST /concat-mp3
 * multipart/form-data with files[] (each is an mp3 chunk)
 * Returns: a single concatenated mp3
 *
 * Client uploads the already-generated chunks, so you never pay again to re-generate.
 */
app.post("/concat-mp3", upload.array("files", 500), async (req, res) => {
  // NOTE: this uses ffmpeg concat demuxer with -c copy
  // Works when all mp3 chunks have compatible encoding (they should, from the same TTS endpoint).
  const files = req.files || [];

  if (!files.length) {
    return res.status(400).json({ error: "No files uploaded" });
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const jobDir = fs.mkdtempSync(path.join(tmpdir(), `tts-concat-${requestId}-`));

  try {
    // Write uploaded chunks to disk with stable ordering
    // Client should name them like chunk_000.mp3, chunk_001.mp3, ...
    const written = [];
    for (const f of files) {
      const safeName = (f.originalname || "chunk.mp3").replace(/[^a-zA-Z0-9._-]/g, "_");
      const outPath = path.join(jobDir, safeName);
      fs.writeFileSync(outPath, f.buffer);
      written.push(outPath);
    }

    written.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

    const listFile = path.join(jobDir, "filelist.txt");
    fs.writeFileSync(listFile, written.map((p) => `file '${p}'`).join("\n"));

    const outPath = path.join(jobDir, "full.mp3");

    await new Promise((resolve, reject) => {
      const ff = spawn("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listFile,
        "-c",
        "copy",
        outPath,
      ]);

      ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
      ff.on("error", reject);
    });

    const final = fs.readFileSync(outPath);

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", `attachment; filename="full_${requestId}.mp3"`);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(final);
  } catch (err) {
    console.error("Concat error:", err);
    res.status(500).json({ error: "Failed to concatenate mp3 chunks" });
  } finally {
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
    } catch {}
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});