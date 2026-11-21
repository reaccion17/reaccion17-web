const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

let queueItems = [];
let cooldownSettings = {
  enabled: true,
  minutes: 120
};
const lastUploadByUser = new Map();

function normalizeUsername(name) {
  return String(name || '').trim().replace(/^@+/, '').toLowerCase();
}

function removeUploadedFile(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Ignorar si el archivo está en uso temporalmente
  }
}

function saveState() {
  try {
    const payload = {
      queueItems,
      cooldownSettings,
      lastUploadByUser: Array.from(lastUploadByUser.entries())
    };
    const tempFile = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tempFile, STATE_FILE);
  } catch (err) {
    console.error('Error guardando estado:', err.message);
  }
}

function cleanupExpiredVideos() {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  let changed = false;

  const remaining = [];
  for (const item of queueItems) {
    const createdAt = Number(item?.createdAt) || 0;
    if (createdAt > 0 && createdAt < cutoff) {
      if (item.diskFile) {
        removeUploadedFile(path.join(UPLOADS_DIR, item.diskFile));
      }
      changed = true;
    } else {
      remaining.push(item);
    }
  }

  if (changed) {
    queueItems = remaining;
    saveState();
  }
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    saveState();
    return;
  }

  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed?.queueItems)) {
      queueItems = parsed.queueItems.filter((item) => {
        if (!item || !item.id || !item.diskFile) return false;
        const fullPath = path.join(UPLOADS_DIR, item.diskFile);
        return fs.existsSync(fullPath);
      });
    }

    if (parsed?.cooldownSettings && typeof parsed.cooldownSettings === 'object') {
      const mins = Number(parsed.cooldownSettings.minutes);
      cooldownSettings = {
        enabled: typeof parsed.cooldownSettings.enabled === 'boolean' ? parsed.cooldownSettings.enabled : true,
        minutes: Number.isFinite(mins) && mins > 0 ? Math.min(10080, Math.round(mins)) : 120
      };
    }

    if (Array.isArray(parsed?.lastUploadByUser)) {
      lastUploadByUser.clear();
      const maxAgeMs = Math.max(cooldownSettings.minutes * 60 * 1000, SEVEN_DAYS_MS);
      const now = Date.now();
      for (const entry of parsed.lastUploadByUser) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const key = normalizeUsername(entry[0]);
        const ts = Number(entry[1]);
        if (key && Number.isFinite(ts) && ts > 0 && (now - ts) <= maxAgeMs) {
          lastUploadByUser.set(key, ts);
        }
      }
    }

    cleanupExpiredVideos();
  } catch (err) {
    console.error('Error cargando estado, iniciando limpio:', err.message);
  }
}

loadState();
setInterval(cleanupExpiredVideos, 60 * 60 * 1000);

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
    removeUploadedFile(req.file?.path);
    return res.status(400).json({ ok: false, error: 'Falta usuario o archivo de video.' });
  }

  const userKey = normalizeUsername(user);
  const now = Date.now();

  if (cooldownSettings.enabled && userKey) {
    const cooldownMs = cooldownSettings.minutes * 60 * 1000;
    const lastUploadAt = lastUploadByUser.get(userKey);

    if (typeof lastUploadAt === 'number') {
      const elapsed = now - lastUploadAt;
      if (elapsed < cooldownMs) {
        removeUploadedFile(req.file.path);
        const remainingMs = cooldownMs - elapsed;
        const remainingSeconds = Math.ceil(remainingMs / 1000);
        const minsLeft = Math.floor(remainingSeconds / 60);
        const secsLeft = remainingSeconds % 60;

        return res.status(429).json({
          ok: false,
          error: 'COOLDOWN_ACTIVE',
          message: `⏳ Cooldown activo: espera ${minsLeft}m ${secsLeft}s para volver a enviar videos.`,
          remainingMs,
          remainingSeconds
        });
      }
    }
  }

  if (userKey) {
    lastUploadByUser.set(userKey, now);
  }

  const id = `vid_${now}_${Math.random().toString(36).slice(2, 6)}`;
  const item = {
    id,
    user,
    fileName: req.file.originalname || req.file.filename,
    diskFile: req.file.filename,
    streamUrl: `/api/queue/${encodeURIComponent(id)}/stream`,
    createdAt: now
  };

  queueItems.push(item);
  saveState();
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
  removeUploadedFile(path.join(UPLOADS_DIR, removed.diskFile));
  saveState();

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
  saveState();
  res.json(cooldownSettings);
});

app.listen(PORT, () => {
  console.log(`Reaccion17 corriendo en http://localhost:${PORT}`);
});