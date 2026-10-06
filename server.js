const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const TMP_DIR = '/tmp/downloads';
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Секретный ключ (задаётся через переменные окружения Railway)
const SECRET = process.env.API_SECRET || 'change-me';

// Cookies для YouTube (из base64 в env)
const COOKIES_PATH = '/tmp/cookies.txt';
if (process.env.YOUTUBE_COOKIES_B64) {
  try {
    const buf = Buffer.from(process.env.YOUTUBE_COOKIES_B64, 'base64');
    fs.writeFileSync(COOKIES_PATH, buf);
    console.log('✅ Cookies loaded');
  } catch (e) {
    console.error('Failed to decode cookies:', e);
  }
}

app.post('/api/download', (req, res) => {
  const { url, quality = 'best', secret } = req.body;

  if (secret !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL обязателен' });
  }

  // Разрешаем только YouTube
  if (!/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url)) {
    return res.status(400).json({ error: 'Только YouTube ссылки' });
  }

  // Уникальная подпапка для каждого запроса (fix race condition)
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const jobDir = path.join(TMP_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const outputTemplate = path.join(jobDir, '%(title).100s.%(ext)s');

  // Выбор формата
  let formatStr;
  let isAudio = false;

  switch (quality) {
    case 'audio':
      formatStr = 'bestaudio/best';
      isAudio = true;
      break;
    case '1080':
      formatStr = 'bestvideo[height<=1080]+bestaudio/best[height<=1080]';
      break;
    case '720':
      formatStr = 'bestvideo[height<=720]+bestaudio/best[height<=720]';
      break;
    case '480':
      formatStr = 'bestvideo[height<=480]+bestaudio/best[height<=480]';
      break;
    default:
      formatStr = 'bestvideo+bestaudio/best';
  }

  const args = [
    url,
    '-f', formatStr,
    '-o', outputTemplate,
    '--no-playlist',
    '--no-check-certificates',
    '--no-warnings',
  ];

  if (fs.existsSync(COOKIES_PATH)) {
    args.push('--cookies', COOKIES_PATH);
  }

  if (isAudio) {
    args.push('-x', '--audio-format', 'mp3');
  } else {
    args.push('--merge-output-format', 'mp4');
  }

  console.log('▶ yt-dlp', args.join(' '));
  const ytdlp = spawn('yt-dlp', args);

  let stderrData = '';
  ytdlp.stderr.on('data', (d) => { stderrData += d.toString(); });

  ytdlp.on('error', (err) => {
    console.error('spawn error:', err);
    fs.rm(jobDir, { recursive: true, force: true }, () => {});
    if (!res.headersSent) {
      res.status(500).json({ error: 'yt-dlp не запустился', detail: err.message });
    }
  });

  ytdlp.on('close', (code) => {
    if (code !== 0) {
      console.error('yt-dlp exit code', code, stderrData.slice(-1000));
      fs.rm(jobDir, { recursive: true, force: true }, () => {});
      if (!res.headersSent) {
        return res.status(500).json({
          error: 'Скачивание не удалось',
          detail: stderrData.slice(-500),
        });
      }
      return;
    }

    const files = fs.readdirSync(jobDir).filter((f) =>
      ['.mp4', '.mp3', '.webm', '.mkv'].includes(path.extname(f).toLowerCase())
    );

    if (files.length === 0) {
      fs.rm(jobDir, { recursive: true, force: true }, () => {});
      return res.status(500).json({ error: 'Файл не создан' });
    }

    const filePath = path.join(jobDir, files[0]);
    const stat = fs.statSync(filePath);
    const fileName = files[0];

    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
    );

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);

    stream.on('end', () => {
      fs.rm(jobDir, { recursive: true, force: true }, () => {});
    });
    stream.on('error', (err) => {
      console.error('stream error:', err);
      fs.rm(jobDir, { recursive: true, force: true }, () => {});
    });
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server on port ${PORT}`);
});