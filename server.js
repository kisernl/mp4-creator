const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const app = express();
const PORT = 3000;

// --- FFmpeg availability flag ---
let ffmpegAvailable = false;

// --- Constants ---
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB per file
const MAX_FILES = 20;
const NORMALIZE_MAX_WIDTH = 1280;
const NORMALIZE_MAX_HEIGHT = 720;
const NORMALIZE_FPS = 30;
const ALLOWED_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/webm',
  'video/mpeg',
];

// --- Multer setup ---
// Custom storage: create a unique temp directory per request,
// then write each uploaded file into that directory.
const storage = multer.diskStorage({
  destination(req, file, cb) {
    // Create a per-request working directory (once per request)
    if (!req.workDir) {
      req.workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp4-merge-'));
      console.log(`Created temp dir: ${req.workDir}`);
    }
    cb(null, req.workDir);
  },
  filename(req, file, cb) {
    // Keep a unique name but preserve the original extension
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

// Filter: reject anything that isn't a video MIME type
function fileFilter(req, file, cb) {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Rejected "${file.originalname}" — MIME type "${file.mimetype}" is not a supported video format.`));
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES,
  },
});

// --- Serve static frontend files from /public ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Health check ---
app.get('/health', (req, res) => {
  console.log('GET /health');
  res.json({ status: 'ok' });
});

// --- Multer error handler (wraps the merge route) ---
function handleUpload(req, res, next) {
  upload.array('videos')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File too large. Max size is ${MAX_FILE_SIZE / 1024 / 1024} MB.` });
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({ error: `Too many files. Max is ${MAX_FILES}.` });
      }
      return res.status(400).json({ error: err.message });
    }
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}

// --- Helper: remove a directory and everything inside it ---
// Tracked set prevents duplicate cleanup when multiple events fire for the same request.
const cleanedUp = new Set();

function cleanupDir(dirPath) {
  if (!dirPath || cleanedUp.has(dirPath)) return;
  cleanedUp.add(dirPath);

  fs.rm(dirPath, { recursive: true, force: true }, (err) => {
    if (err) console.error(`Cleanup error for ${dirPath}:`, err);
    else console.log(`Cleaned up temp dir: ${dirPath}`);
    // Remove from set after a delay so rapid duplicate calls are still suppressed
    setTimeout(() => cleanedUp.delete(dirPath), 5000);
  });
}

// --- Startup cleanup: remove orphaned temp directories from previous runs ---
function cleanupOrphaned() {
  const tmpDir = os.tmpdir();
  const PREFIX = 'mp4-merge-';

  let entries;
  try {
    entries = fs.readdirSync(tmpDir);
  } catch {
    return; // Can't read tmpdir — nothing to do
  }

  const orphaned = entries.filter((name) => name.startsWith(PREFIX));
  if (orphaned.length === 0) return;

  console.log(`Found ${orphaned.length} orphaned temp dir(s) from a previous run — cleaning up`);
  orphaned.forEach((name) => {
    const fullPath = path.join(tmpDir, name);
    fs.rm(fullPath, { recursive: true, force: true }, (err) => {
      if (err) console.error(`  Failed to remove ${name}:`, err.message);
      else console.log(`  Removed ${name}`);
    });
  });
}

// --- Normalize a single video file to a consistent format ---
// Returns a promise that resolves with the path to the normalized file.
function normalizeFile(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', inputPath,
      // Video: H.264, scale down to fit within max resolution, preserve aspect ratio, pad to even dimensions
      '-vf', `scale='min(${NORMALIZE_MAX_WIDTH},iw)':min'(${NORMALIZE_MAX_HEIGHT},ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2`,
      '-r', String(NORMALIZE_FPS),
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      // Audio: AAC stereo at 128k, 44.1 kHz
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-ac', '2',
      // MP4 container
      '-movflags', '+faststart',
      outputPath,
    ];

    execFile('ffmpeg', args, { maxBuffer: 10 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        console.error(`Normalize failed for ${path.basename(inputPath)}:`, stderr);
        reject(new Error(`Failed to normalize "${path.basename(inputPath)}".`));
      } else {
        console.log(`Normalized: ${path.basename(inputPath)} -> ${path.basename(outputPath)}`);
        resolve(outputPath);
      }
    });
  });
}

// --- Normalize all files sequentially, returns array of normalized file paths ---
async function normalizeAll(files, workDir) {
  const normalized = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const outputPath = path.join(workDir, `norm-${i}.mp4`);
    console.log(`Normalizing file ${i + 1}/${files.length}: ${file.originalname}`);
    await normalizeFile(file.path, outputPath);
    normalized.push(outputPath);
  }
  return normalized;
}

// --- Concatenate normalized files into a single MP4 ---
// Writes a concat list file, runs FFmpeg concat demuxer, returns the output path.
function concatFiles(normalizedPaths, workDir) {
  return new Promise((resolve, reject) => {
    // Build the concat list (one "file '<path>'" per line)
    const listPath = path.join(workDir, 'concat-list.txt');
    const listContent = normalizedPaths.map((p) => `file '${p}'`).join('\n');
    fs.writeFileSync(listPath, listContent);
    console.log(`Concat list written to ${listPath} (${normalizedPaths.length} entries)`);

    const outputPath = path.join(workDir, 'merged.mp4');

    const args = [
      '-y',
      '-f', 'concat',       // Use the concat demuxer
      '-safe', '0',          // Allow absolute paths in the list file
      '-i', listPath,
      '-c', 'copy',          // Stream-copy (no re-encode) since inputs are already normalized
      '-movflags', '+faststart',
      outputPath,
    ];

    console.log('Running FFmpeg concat...');

    execFile('ffmpeg', args, { maxBuffer: 10 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        console.error('FFmpeg concat error:', stderr);
        reject(new Error('FFmpeg failed to concatenate videos.'));
      } else {
        console.log(`Concat complete: ${path.basename(outputPath)}`);
        resolve(outputPath);
      }
    });
  });
}

// --- FFmpeg guard: reject merge requests if FFmpeg is not installed ---
function requireFFmpeg(req, res, next) {
  if (!ffmpegAvailable) {
    return res.status(503).json({
      error: 'FFmpeg is not installed or not found in PATH.',
      instructions: [
        'macOS:    brew install ffmpeg',
        'Ubuntu:   sudo apt install ffmpeg',
        'Windows:  Download from https://ffmpeg.org/download.html and add to PATH',
      ],
    });
  }
  next();
}

// --- Merge endpoint ---
app.post('/merge', requireFFmpeg, handleUpload, (req, res) => {
  const files = req.files;
  const workDir = req.workDir;

  console.log(`POST /merge — received ${files.length} file(s)`);

  if (!files || files.length < 2) {
    if (workDir) cleanupDir(workDir);
    return res.status(400).json({ error: 'Upload at least 2 video files.' });
  }

  // Parse the client-supplied order (array of original filenames in desired sequence)
  let order;
  try {
    order = JSON.parse(req.body.order);
  } catch {
    cleanupDir(workDir);
    return res.status(400).json({ error: 'Invalid order parameter.' });
  }

  // Sort uploaded files to match the requested order
  const sorted = order.map((name) => files.find((f) => f.originalname === name));
  if (sorted.some((f) => !f)) {
    cleanupDir(workDir);
    return res.status(400).json({ error: 'Order contains filenames that were not uploaded.' });
  }

  // Normalize all files to a consistent format, then concat
  console.log('Starting normalization...');

  normalizeAll(sorted, workDir)
    .then((normalizedPaths) => concatFiles(normalizedPaths, workDir))
    .then((outputPath) => {
      const stat = fs.statSync(outputPath);
      console.log(`Merge complete — streaming ${(stat.size / 1024 / 1024).toFixed(1)} MB to client`);

      // Set headers so the browser triggers a file download
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'attachment; filename="merged.mp4"');
      res.setHeader('Content-Length', stat.size);

      const stream = fs.createReadStream(outputPath);

      stream.pipe(res);

      // Clean up temp directory once the stream finishes (success or abort)
      stream.on('end', () => {
        console.log('Download stream finished');
        cleanupDir(workDir);
      });

      stream.on('error', (streamErr) => {
        console.error('Stream read error:', streamErr);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to stream the merged file.' });
        }
        cleanupDir(workDir);
      });

      // If the client disconnects mid-download, still clean up
      res.on('close', () => {
        stream.destroy();
        cleanupDir(workDir);
      });
    })
    .catch((err) => {
      console.error('Merge pipeline error:', err.message);
      cleanupDir(workDir);
      res.status(500).json({ error: err.message });
    });
});

// --- Startup ---
cleanupOrphaned();

// Check for FFmpeg, then start server
execFile('ffmpeg', ['-version'], (err, stdout) => {
  if (err) {
    console.error('');
    console.error('=== FFmpeg not found ===');
    console.error('This application requires FFmpeg to merge videos.');
    console.error('');
    console.error('Install it for your platform:');
    console.error('  macOS:    brew install ffmpeg');
    console.error('  Ubuntu:   sudo apt install ffmpeg');
    console.error('  Windows:  Download from https://ffmpeg.org/download.html and add to PATH');
    console.error('');
    console.error('The server will start, but /merge requests will be rejected until FFmpeg is available.');
    console.error('');
  } else {
    const versionLine = stdout.split('\n')[0];
    console.log(`FFmpeg found: ${versionLine}`);
    ffmpegAvailable = true;
  }

  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
});
