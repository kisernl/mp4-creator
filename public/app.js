(function () {
  'use strict';

  // --- Constants (must match server) ---
  var MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB
  var MAX_FILES = 20;
  var ALLOWED_TYPES = [
    'video/mp4',
    'video/quicktime',
    'video/x-msvideo',
    'video/x-matroska',
    'video/webm',
    'video/mpeg',
  ];

  // --- State: ordered array of File objects ---
  let files = [];

  // --- DOM refs ---
  const fileInput = document.getElementById('file-input');
  const fileList = document.getElementById('file-list');
  const mergeBtn = document.getElementById('merge-btn');
  const statusEl = document.getElementById('status');
  const statusText = document.getElementById('status-text');
  const errorEl = document.getElementById('error');

  // =========================================================
  // File selection
  // =========================================================
  fileInput.addEventListener('change', () => {
    const newFiles = Array.from(fileInput.files);
    if (newFiles.length === 0) return;

    const errors = [];

    // Validate each new file
    const accepted = newFiles.filter((f) => {
      if (!ALLOWED_TYPES.includes(f.type)) {
        errors.push(`"${f.name}" — unsupported type (${f.type || 'unknown'}). Use MP4, MOV, AVI, MKV, or WebM.`);
        return false;
      }
      if (f.size > MAX_FILE_SIZE) {
        errors.push(`"${f.name}" — too large (${formatSize(f.size)}). Max is ${formatSize(MAX_FILE_SIZE)}.`);
        return false;
      }
      return true;
    });

    // Check total file count
    if (files.length + accepted.length > MAX_FILES) {
      errors.push(`Too many files. You can add up to ${MAX_FILES} total (currently ${files.length}).`);
      accepted.splice(MAX_FILES - files.length);
    }

    if (accepted.length > 0) {
      files = files.concat(accepted);
    }

    fileInput.value = ''; // reset so the same files can be re-added

    if (errors.length > 0) {
      showError(errors.join('\n'));
    }

    render();
  });

  // =========================================================
  // Render the ordered list
  // =========================================================
  function render() {
    fileList.innerHTML = '';

    files.forEach((file, index) => {
      const li = document.createElement('li');
      li.draggable = true;
      li.dataset.index = index;

      // Grip handle
      const grip = document.createElement('span');
      grip.className = 'grip';
      grip.textContent = '\u2630'; // hamburger icon ☰

      // Filename
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = file.name;

      // Remove button
      const remove = document.createElement('button');
      remove.className = 'remove';
      remove.textContent = '\u00d7'; // ×
      remove.addEventListener('click', () => {
        files.splice(index, 1);
        render();
      });

      li.appendChild(grip);
      li.appendChild(name);
      li.appendChild(remove);
      fileList.appendChild(li);
    });

    // Enable button only when 2+ files
    mergeBtn.disabled = files.length < 2;
  }

  // =========================================================
  // Drag-and-drop reordering
  // =========================================================
  let dragIndex = null;

  fileList.addEventListener('dragstart', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    dragIndex = Number(li.dataset.index);
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  fileList.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const li = e.target.closest('li');
    if (!li) return;

    const targetIndex = Number(li.dataset.index);
    if (targetIndex === dragIndex) return;

    // Reorder the files array
    const [moved] = files.splice(dragIndex, 1);
    files.splice(targetIndex, 0, moved);
    dragIndex = targetIndex;

    render();
  });

  fileList.addEventListener('dragend', (e) => {
    dragIndex = null;
    const li = e.target.closest('li');
    if (li) li.classList.remove('dragging');
  });

  // =========================================================
  // Merge: upload files and trigger download
  // =========================================================
  mergeBtn.addEventListener('click', async () => {
    if (files.length < 2) return;

    setProcessing(true);
    hideError();

    // Build FormData with files and their order
    const formData = new FormData();
    const order = files.map((f) => f.name);
    formData.append('order', JSON.stringify(order));
    files.forEach((f) => formData.append('videos', f));

    try {
      const res = await fetch('/merge', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw formatServerError(res.status, body);
      }

      // Trigger browser download from the response blob
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'merged.mp4';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      statusText.textContent = 'Done!';
    } catch (err) {
      showError(err.message);
    } finally {
      setProcessing(false);
    }
  });

  // =========================================================
  // UI helpers
  // =========================================================
  function setProcessing(active) {
    statusEl.hidden = !active;
    statusText.textContent = 'Processing...';
    mergeBtn.disabled = active;
    fileInput.disabled = active;

    // Disable remove buttons and dragging during processing
    fileList.querySelectorAll('li').forEach((li) => {
      li.draggable = !active;
    });
    fileList.querySelectorAll('.remove').forEach((btn) => {
      btn.disabled = active;
    });
  }

  function showError(message) {
    errorEl.hidden = false;
    // Support multiline: split on newlines and render as separate lines
    errorEl.innerHTML = '';
    message.split('\n').forEach((line, i) => {
      if (i > 0) errorEl.appendChild(document.createElement('br'));
      errorEl.appendChild(document.createTextNode(line));
    });
  }

  function hideError() {
    errorEl.innerHTML = '';
    errorEl.hidden = true;
  }

  // Map server error responses into developer-friendly messages
  function formatServerError(status, body) {
    const base = body.error || 'Something went wrong.';

    if (status === 503 && body.instructions) {
      // FFmpeg not installed — include install instructions
      return new Error(base + '\n\n' + body.instructions.join('\n'));
    }

    if (status === 413) {
      return new Error(base + '\nTry trimming or compressing your videos before uploading.');
    }

    if (status === 400) {
      return new Error(base);
    }

    if (status === 500) {
      return new Error(base + '\nCheck the server terminal for FFmpeg output.');
    }

    return new Error(base + ' (HTTP ' + status + ')');
  }

  // Format bytes into a human-readable string
  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
})();
