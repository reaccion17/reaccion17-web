const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const REMOTE_STATE_PATH = 'state/reaccion17-state.json';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'reaccion17-videos';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('⚠️ Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en las variables de entorno.');
}

const supabase = createClient(SUPABASE_URL || '', SUPABASE_SERVICE_ROLE_KEY || '', {
  auth: { persistSession: false }
});

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

let queueItems = [];
let cooldownSettings = {
  enabled: true,
  minutes: 120
};
const lastUploadByUser = new Map();
let stateLoadedSuccessfully = false;

function normalizeUsername(name) {
  return String(name || '').trim().replace(/^@+/, '').toLowerCase();
}

function getPublicVideoUrl(storagePath) {
  if (!storagePath) return '';
  const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(storagePath);
  return data?.publicUrl || '';
}

async function deleteStorageObject(storagePath) {
  if (!storagePath) return;
  try {
    const { error } = await supabase.storage.from(SUPABASE_BUCKET).remove([storagePath]);
    if (error) {
      console.error('Error borrando objeto en Supabase Storage:', error.message);
    }
  } catch (err) {
    console.error('Excepción borrando objeto en Supabase Storage:', err.message);
  }
}

async function deleteFallbackVideoById(id) {
  const cleanId = String(id || '').trim();
  if (!cleanId || cleanId.startsWith('local_')) return;

  const candidatePaths = ['.mp4', '.webm', '.mov', '.mkv', '.m4v'].map((ext) => `videos/${cleanId}${ext}`);
  try {
    const { error } = await supabase.storage.from(SUPABASE_BUCKET).remove(candidatePaths);
    if (error) {
      console.error('Error en borrado de respaldo en Supabase Storage:', error.message);
    }
  } catch (err) {
    console.error('Excepción en borrado de respaldo en Supabase Storage:', err.message);
  }
}

function buildStatePayload() {
  return {
    queueItems,
    cooldownSettings,
    lastUploadByUser: Array.from(lastUploadByUser.entries())
  };
}

function writeLocalStateFile(payload) {
  try {
    const tempFile = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tempFile, STATE_FILE);
  } catch (err) {
    console.error('Error guardando estado local:', err.message);
  }
}

async function syncStateToSupabase(payload) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const buffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    const { error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(REMOTE_STATE_PATH, buffer, {
        contentType: 'application/json',
        upsert: true
      });
    if (error) {
      console.error('❌ Error guardando estado en Supabase Storage:', error.message);
    } else {
      console.log(`✅ Estado sincronizado en Supabase Storage (${payload.queueItems.length} videos).`);
    }
  } catch (err) {
    console.error('❌ Excepción guardando estado en Supabase Storage:', err.message);
  }
}

function saveState() {
  const payload = buildStatePayload();
  writeLocalStateFile(payload);
  return syncStateToSupabase(payload);
}

function hydrateStateFromObject(parsed) {
  if (!parsed || typeof parsed !== 'object') return;

  if (Array.isArray(parsed.queueItems)) {
    queueItems = parsed.queueItems
      .filter((item) => item && item.id && item.storagePath)
      .map((item) => ({
        ...item,
        publicUrl: item.publicUrl || getPublicVideoUrl(item.storagePath),
        streamUrl: `/api/queue/${encodeURIComponent(item.id)}/stream`
      }));
  }

  if (parsed.cooldownSettings && typeof parsed.cooldownSettings === 'object') {
    const mins = Number(parsed.cooldownSettings.minutes);
    cooldownSettings = {
      enabled: typeof parsed.cooldownSettings.enabled === 'boolean' ? parsed.cooldownSettings.enabled : true,
      minutes: Number.isFinite(mins) && mins > 0 ? Math.min(10080, Math.round(mins)) : 120
    };
  }

  if (Array.isArray(parsed.lastUploadByUser)) {
    lastUploadByUser.clear();
    const cooldownMs = Math.max(cooldownSettings.minutes * 60 * 1000, 24 * 60 * 60 * 1000);
    const now = Date.now();
    for (const entry of parsed.lastUploadByUser) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const key = normalizeUsername(entry[0]);
      const ts = Number(entry[1]);
      if (key && Number.isFinite(ts) && ts > 0 && (now - ts) <= cooldownMs) {
        lastUploadByUser.set(key, ts);
      }
    }
  }
}

async function loadStateFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, notFound: false, data: null };
  }
  try {
    const { data, error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .download(REMOTE_STATE_PATH);

    if (error) {
      const msg = String(error.message || '').toLowerCase();
      const notFound = msg.includes('not found') || msg.includes('object not found') || error.statusCode === '404' || error.statusCode === 404;
      if (!notFound) {
        console.error('⚠️ Error descargando estado desde Supabase Storage:', error.message);
      }
      return { ok: false, notFound, data: null };
    }

    if (!data) {
      return { ok: true, notFound: true, data: null };
    }

    const text = await data.text();
    const parsed = JSON.parse(text);
    return {
      ok: true,
      notFound: false,
      data: parsed && typeof parsed === 'object' ? parsed : null
    };
  } catch (err) {
    console.error('⚠️ Excepción leyendo estado desde Supabase Storage:', err.message);
    return { ok: false, notFound: false, data: null };
  }
}

async function loadState() {
  const remoteResult = await loadStateFromSupabase();

  if (remoteResult.ok && remoteResult.data) {
    hydrateStateFromObject(remoteResult.data);
    stateLoadedSuccessfully = true;
    writeLocalStateFile(buildStatePayload());
    console.log(`📥 Estado cargado desde Supabase Storage (${queueItems.length} videos).`);
  } else if (fs.existsSync(STATE_FILE)) {
    try {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      hydrateStateFromObject(parsed);
      console.log(`📂 Estado cargado desde disco local (${queueItems.length} videos).`);
    } catch (err) {
      console.error('Error cargando estado local:', err.message);
    }
    if (remoteResult.ok && remoteResult.notFound) {
      await saveState();
    }
  } else if (remoteResult.ok && remoteResult.notFound) {
    await saveState();
  } else {
    console.warn('⚠️ No se pudo leer el estado remoto ni local al iniciar; se evitará sobrescribir hasta tener cambios.');
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 250 * 1024 * 1024 }
});

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get('/api/queue', (_req, res) => {
  res.json({ items: queueItems });
});

app.post('/api/queue', upload.single('file'), async (req, res) => {
  const user = String(req.body?.user || '').trim();
  if (!user || !req.file) {
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

  const ext = path.extname(req.file.originalname || '.mp4').toLowerCase() || '.mp4';
  const id = `vid_${now}_${Math.random().toString(36).slice(2, 6)}`;
  const storagePath = `videos/${id}${ext}`;

  try {
    const { error: uploadError } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype || 'video/mp4',
        upsert: false
      });

    if (uploadError) {
      console.error('Error subiendo a Supabase Storage:', uploadError.message);
      return res.status(502).json({
        ok: false,
        error: 'No se pudo subir el video a Supabase Storage.'
      });
    }

    if (userKey) {
      lastUploadByUser.set(userKey, now);
    }

    const publicUrl = getPublicVideoUrl(storagePath);
    const item = {
      id,
      user,
      fileName: req.file.originalname || `${id}${ext}`,
      storagePath,
      publicUrl,
      streamUrl: `/api/queue/${encodeURIComponent(id)}/stream`,
      createdAt: now
    };

    queueItems.push(item);
    await saveState();
    return res.status(201).json(item);
  } catch (err) {
    console.error('Error inesperado en POST /api/queue:', err.message);
    return res.status(500).json({ ok: false, error: 'Error interno al procesar el video.' });
  }
});

app.get('/api/queue/:id/stream', (req, res) => {
  const item = queueItems.find((v) => v.id === req.params.id);
  if (!item || !item.storagePath) {
    return res.status(404).send('Video no encontrado');
  }

  const publicUrl = item.publicUrl || getPublicVideoUrl(item.storagePath);
  if (!publicUrl) {
    return res.status(404).send('URL de video no disponible');
  }

  return res.redirect(302, publicUrl);
});

app.delete('/api/queue/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  const idx = queueItems.findIndex((v) => v.id === id);

  if (idx === -1) {
    await deleteFallbackVideoById(id);
    return res.json({ ok: true, deleted: false });
  }

  const [removed] = queueItems.splice(idx, 1);
  if (removed.storagePath) {
    await deleteStorageObject(removed.storagePath);
  } else {
    await deleteFallbackVideoById(removed.id);
  }
  await saveState();

  return res.json({ ok: true, deleted: true });
});

app.get('/api/settings/cooldown', (_req, res) => {
  res.json(cooldownSettings);
});

app.put('/api/settings/cooldown', async (req, res) => {
  const enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : cooldownSettings.enabled;
  const rawMins = Number(req.body?.minutes);
  const minutes = Number.isFinite(rawMins) && rawMins > 0 ? Math.min(10080, Math.round(rawMins)) : cooldownSettings.minutes;

  cooldownSettings = { enabled, minutes };
  await saveState();
  res.json(cooldownSettings);
});

loadState().then(() => {
  app.listen(PORT, () => {
    console.log(`Reaccion17 corriendo en http://localhost:${PORT} (remoteLoaded=${stateLoadedSuccessfully})`);
  });
});