# VRChat Asset Manager — Workers Edition

Browser-direct S3 uploads for maximum speed. No server bottleneck.

## Architecture

- **Cloudflare Worker** (`worker.js`): Proxies VRChat API calls (CORS bypass)
- **Browser** (`index.html` + `app.js`): Does everything else:
  - Rsync signature computation
  - Gzip compression
  - Direct S3 multipart upload with real-time progress

## Quick Start

```bash
# Install wrangler (if not already)
npm i -g wrangler

# Login to Cloudflare
wrangler login

# Local development
wrangler dev

# Deploy to production
wrangler deploy
```

## Local Development

```bash
cd d:\Doc\vvvrc-workers
wrangler dev
```

Open `http://localhost:8787` in your browser.

## Features

- 🚀 **Browser-direct S3 uploads** (no server middleman)
- 📊 Real-time upload progress with speed display
- 🌍 Trilingual (EN / 中文 / 日本語)
- 🔒 VRChat 2FA support
- ⬇️ Browser-native file downloads
- 🔄 Batch upload support
- 🌐 Optional proxy support
