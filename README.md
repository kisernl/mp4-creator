# MP4 Creator

A local web app that merges multiple video files into a single MP4. Upload videos, drag to reorder, and download the result.

## What it does

- Accepts multiple video files (MP4, MOV, AVI, MKV, WebM)
- Lets you reorder them via drag-and-drop
- Normalizes all videos to a consistent format (H.264, AAC, 720p, 30fps)
- Concatenates them into a single MP4
- Downloads the merged file to your machine

## What it does NOT do

- No cloud uploads — everything stays on your machine
- No accounts or authentication
- No video previews or thumbnails
- No background processing or job queues
- No database — completely stateless
- No Docker required

## Prerequisites

- **Node.js** (v18 or later) — [nodejs.org](https://nodejs.org)
- **FFmpeg** installed and available in your PATH

### Installing FFmpeg

**macOS**
```
brew install ffmpeg
```

**Ubuntu / Debian**
```
sudo apt update && sudo apt install ffmpeg
```

**Windows**

Download from [ffmpeg.org/download.html](https://ffmpeg.org/download.html) and add the `bin` folder to your system PATH.

**Verify installation**
```
ffmpeg -version
```

## Running the app

```
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

The server will check for FFmpeg on startup and log a warning if it's missing.

## How it works

1. Files are uploaded to a temporary directory inside your OS temp folder (`/tmp` on macOS/Linux, `%TEMP%` on Windows)
2. Each video is re-encoded to a consistent format (H.264 video, AAC audio, 720p max, 30fps)
3. The normalized files are concatenated using FFmpeg's concat demuxer
4. The merged MP4 is streamed back as a download
5. All temporary files are deleted immediately after

## Temp file storage

Temporary files are stored in your OS temp directory under folders named `mp4-merge-*`. These are cleaned up:

- After every successful or failed request
- On server startup (removes orphans from previous crashes)

No files are stored in the project directory.

## Known limitations

- **Processing is synchronous** — one merge runs at a time per request; large files will take a while
- **500 MB per file limit** — configurable in `server.js` (`MAX_FILE_SIZE`)
- **20 file maximum** — configurable in `server.js` (`MAX_FILES`)
- **Re-encoding is slow** — every file is normalized before merging, even if it's already in the target format
- **No progress reporting** — the browser waits until the entire merge is complete
- **Duplicate filenames** — if two files have the same name, ordering may not work correctly
