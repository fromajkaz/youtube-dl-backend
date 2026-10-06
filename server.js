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

// Простой секретный ключ, чтобы никто чужой не использовал твой сервер
const SECRET = process.env.API_SECRET || 'change-me';

app.post('/api/download', (req, res) => {
  const { url, quality = 'best', secret } = req.body;

  if (secret !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL обязателен' });
  }

const isYouTube = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url);
const isTikTok = /^https?:\/\/(www\.)?tiktok\.com\//i.test(url);

if (!isYouTube && !isTikTok) {
  return res.status(400).json({ error: 'Только YouTube или TikTok ссылки' });
}

  // Чистим папку от старых файлов на всякий случай
  fs.readdirSync(TMP_DIR).forEach((f) => {
    try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch (_) {}
  });

  const outputTemplate = path.join(TMP_DIR, '%(title).100s.%(ext)s');

let formatStr;
let isAudio = false;

if (isTikTok) {
  // TikTok: один готовый файл, никаких склеек
  if (quality === 'audio') {
    formatStr = 'bestaudio/best';
    isAudio = true;
  } else {
    formatStr = 'best'; // лучшее что есть одним файлом
  }
} else {
  // YouTube: раздельные потоки видео + аудио, склейка через ffmpeg
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
}

  const args = [
    url,
    '-f', formatStr,
    '-o', outputTemplate,
    '--no-playlist',
    '--no-check-certificates',
    '--no-warnings',
  ];

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
    if (!res.headersSent) {
      res.status(500).json({ error: 'yt-dlp не запустился', detail: err.message });
    }
  });

  ytdlp.on('close', (code) => {
    if (code !== 0) {
      console.error('yt-dlp exit code', code, stderrData.slice(-1000));
      if (!res.headersSent) {
        return res.status(500).json({
          error: 'Скачивание не удалось',
          detail: stderrData.slice(-500),
        });
      }
      return;
    }

    const files = fs.readdirSync(TMP_DIR).filter((f) =>
      ['.mp4', '.mp3', '.webm', '.mkv'].includes(path.extname(f).toLowerCase())
    );

    if (files.length === 0) {
      return res.status(500).json({ error: 'Файл не создан' });
    }

    const filePath = path.join(TMP_DIR, files[0]);
    const stat = fs.statSync(filePath);
    const fileName = files[0];

    res.setHeader(
      'Content-Type',
      isAudio ? 'audio/mpeg' : 'video/mp4'
    );
    res.setHeader('Content-Length', stat.size);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
    );

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);

    stream.on('end', () => {
      fs.unlink(filePath, () => {});
    });
    stream.on('error', (err) => {
      console.error('stream error:', err);
      fs.unlink(filePath, () => {});
    });
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server on port ${PORT}`);
});