const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

let queueItems = [];
let cooldownSettings = {
  enabled: true,
  minutes: 120
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '.mp4') || '.mp4';
    const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, safeName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 250 * 1024 * 1024 }
});

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get('/api/queue', (_req, res) => {
  res.json({ items: queueItems });
});

app.post('/api/queue', upload.single('file'), (req, res) => {
  const user = String(req.body?.user || '').trim();
  if (!user || !req.file) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(400).json({ ok: false, error: 'Falta usuario o archivo de video.' });
  }

  const id = `vid_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const item = {
    id,
    user,
    fileName: req.file.originalname || req.file.filename,
    diskFile: req.file.filename,
    streamUrl: `/api/queue/${encodeURIComponent(id)}/stream`,
    createdAt: Date.now()
  };

  queueItems.push(item);
  return res.status(201).json(item);
});

app.get('/api/queue/:id/stream', (req, res) => {
  const item = queueItems.find((v) => v.id === req.params.id);
  if (!item) {
    return res.status(404).send('Video no encontrado');
  }

  const filePath = path.join(UPLOADS_DIR, item.diskFile);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Archivo no disponible');
  }

  return res.sendFile(filePath);
});

app.delete('/api/queue/:id', (req, res) => {
  const idx = queueItems.findIndex((v) => v.id === req.params.id);
  if (idx === -1) {
    return res.json({ ok: true, deleted: false });
  }

  const [removed] = queueItems.splice(idx, 1);
  const filePath = path.join(UPLOADS_DIR, removed.diskFile);

  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Ignorar si está en uso temporalmente
    }
  }

  return res.json({ ok: true, deleted: true });
});

app.get('/api/settings/cooldown', (_req, res) => {
  res.json(cooldownSettings);
});

app.put('/api/settings/cooldown', (req, res) => {
  const enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : cooldownSettings.enabled;
  const rawMins = Number(req.body?.minutes);
  const minutes = Number.isFinite(rawMins) && rawMins > 0 ? Math.min(10080, Math.round(rawMins)) : cooldownSettings.minutes;

  cooldownSettings = { enabled, minutes };
  res.json(cooldownSettings);
});

app.listen(PORT, () => {
  console.log(`Reaccion17 corriendo en http://localhost:${PORT}`);
});