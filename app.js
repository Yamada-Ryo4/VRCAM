/**
 * VRChat Asset Manager — Frontend (Workers Edition)
 * Browser-direct S3 uploads: no server middleman!
 */

// ── Config ──
const API_BASE = location.origin;  // Worker serves from same origin
let vrcAuth = localStorage.getItem('vrc_auth') || '';
let avatars = [];
let selectedIds = new Set();
let uploadFiles = [];
let currentLang = localStorage.getItem('vrc_lang') || 'zh';

// ── i18n ──
const I18N = {
    en: {
        loginSubtitle: "Sign in with your VRChat account", labelUser: "Username or Email", labelPass: "Password",
        btnSignIn: "Sign In", tfa2faRequired: "Two-factor authentication required", labelCode: "Verification Code",
        btnVerify: "Verify", tabDownload: "Download", tabUpload: "Upload", btnSignOut: "Sign Out",
        statTotal: "Total", statSelected: "Selected", actions: "Actions", btnSelectAll: "Select All",
        btnDownload: "Download Selected", btnRefresh: "Refresh", console: "Console", ready: "Ready.",
        uploadMode: "Upload Mode", modeNew: "Create New", modeUpdate: "Update Existing",
        dropText: "Click or drag .vrca files here", dropHint: "Max 500 MB per file",
        avatarName: "Avatar Name", selectAvatar: "Select Avatar to Update", btnUpload: "Upload",
        uploading: "Uploading...", uploadOk: "Upload successful!", uploadFail: "Upload failed: ",
    },
    zh: {
        loginSubtitle: "使用 VRChat 账号登录", labelUser: "用户名或邮箱", labelPass: "密码",
        btnSignIn: "登录", tfa2faRequired: "需要两步验证", labelCode: "验证码",
        btnVerify: "验证", tabDownload: "下载", tabUpload: "上传", btnSignOut: "退出登录",
        statTotal: "总数", statSelected: "已选", actions: "操作", btnSelectAll: "全选",
        btnDownload: "下载选中", btnRefresh: "刷新", console: "控制台", ready: "就绪。",
        uploadMode: "上传模式", modeNew: "新建", modeUpdate: "更新已有",
        dropText: "点击或拖拽 .vrca 文件到这里", dropHint: "每个文件最大 500 MB",
        avatarName: "模型名称", selectAvatar: "选择要更新的模型", btnUpload: "上传",
        uploading: "上传中...", uploadOk: "上传成功！", uploadFail: "上传失败：",
    },
    ja: {
        loginSubtitle: "VRChatアカウントでログイン", labelUser: "ユーザー名またはメール", labelPass: "パスワード",
        btnSignIn: "サインイン", tfa2faRequired: "二段階認証が必要です", labelCode: "認証コード",
        btnVerify: "認証", tabDownload: "ダウンロード", tabUpload: "アップロード", btnSignOut: "サインアウト",
        statTotal: "合計", statSelected: "選択済み", actions: "アクション", btnSelectAll: "全選択",
        btnDownload: "選択をダウンロード", btnRefresh: "更新", console: "コンソール", ready: "準備完了。",
        uploadMode: "アップロードモード", modeNew: "新規作成", modeUpdate: "既存を更新",
        dropText: ".vrcaファイルをここにドラッグ", dropHint: "最大500MB",
        avatarName: "アバター名", selectAvatar: "更新するアバターを選択", btnUpload: "アップロード",
        uploading: "アップロード中...", uploadOk: "アップロード成功！", uploadFail: "アップロード失敗：",
    }
};

function t(key) { return (I18N[currentLang] || I18N.en)[key] || (I18N.en[key] || key); }

function setLang(lang) {
    currentLang = lang;
    localStorage.setItem('vrc_lang', lang);
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const val = t(key);
        if (val) el.textContent = val;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        const val = t(key);
        if (val) el.placeholder = val;
    });
    document.querySelectorAll('.lang-btn').forEach(b => b.classList.toggle('active', b.textContent.trim() === ({ en: 'EN', zh: '中文', ja: '日本語' }[lang] || '')));
}

// ── API Helper ──
async function apiCall(path, options = {}) {
    const headers = options.headers || {};
    if (vrcAuth) headers['X-VRC-Auth'] = vrcAuth;
    if (options.json) {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(options.json);
        delete options.json;
    }
    const resp = await fetch(`${API_BASE}${path}`, { ...options, headers });
    // Update auth from response
    const newAuth = resp.headers.get('X-VRC-Auth');
    if (newAuth) {
        vrcAuth = newAuth;
        localStorage.setItem('vrc_auth', vrcAuth);
    }
    return resp;
}

// ── Login ──
async function doLogin() {
    const user = document.getElementById('username').value.trim();
    const pass = document.getElementById('password').value.trim();
    if (!user || !pass) return;

    const btn = document.getElementById('btnLogin');
    btn.disabled = true;
    const errEl = document.getElementById('login-error');
    errEl.style.display = 'none';

    try {
        const resp = await apiCall('/api/login', { method: 'POST', json: { username: user, password: pass } });
        const data = await resp.json();
        if (data.ok) {
            if (data.needs2FA) {
                document.getElementById('tfa-section').classList.add('active');
            } else {
                showMainApp();
            }
        } else {
            errEl.textContent = data.message || 'Login failed';
            errEl.style.display = 'block';
        }
    } catch (e) {
        errEl.textContent = 'Network error';
        errEl.style.display = 'block';
    }
    btn.disabled = false;
}

async function doVerify2FA() {
    const code = document.getElementById('tfaCode').value.trim();
    if (!code) return;
    try {
        const resp = await apiCall('/api/2fa', { method: 'POST', json: { code } });
        const data = await resp.json();
        if (data.ok) {
            showMainApp();
        } else {
            alert(data.message || 'Invalid code');
        }
    } catch (e) {
        alert('Network error');
    }
}

function doLogout() {
    vrcAuth = '';
    localStorage.removeItem('vrc_auth');
    document.getElementById('loginPage').classList.remove('hidden');
    document.getElementById('mainApp').classList.add('hidden');
}

function showMainApp() {
    document.getElementById('loginPage').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');
    fetchAvatars();
}

// ── Tabs ──
function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.tab-btn[onclick*="${tab}"]`).classList.add('active');
    document.getElementById('downloadPanel').classList.toggle('active', tab === 'download');
    document.getElementById('uploadPanel').classList.toggle('active', tab === 'upload');
}

// ── Avatars ──
async function fetchAvatars() {
    logMsg('Fetching avatars...', 'info');
    try {
        const resp = await apiCall('/api/avatars');
        if (!resp.ok) { logMsg('Failed to fetch avatars', 'error'); return; }
        avatars = await resp.json();
        renderAvatars();
        logMsg(`Found ${avatars.length} avatars`, 'success');
        document.getElementById('statTotal').textContent = avatars.length;
        // Also populate upload avatar select
        const sel = document.getElementById('avatarSelect');
        sel.innerHTML = '<option value="">-- Select --</option>';
        avatars.forEach(a => {
            sel.innerHTML += `<option value="${a.id}">${a.name}</option>`;
        });
    } catch (e) {
        logMsg('Error: ' + e.message, 'error');
    }
}

function renderAvatars() {
    const grid = document.getElementById('avatarGrid');
    grid.innerHTML = '';
    avatars.forEach(av => {
        const thumb = av.thumbnailImageUrl || av.imageUrl || '';
        const card = document.createElement('div');
        card.className = 'avatar-card' + (selectedIds.has(av.id) ? ' selected' : '');
        card.onclick = () => toggleSelect(av.id);
        card.innerHTML = `
            <img class="avatar-thumb" src="${thumb}" alt="${av.name}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 1 1%22><rect fill=%22%23222%22 width=%221%22 height=%221%22/></svg>'">
            <div class="avatar-name">${av.name}</div>
        `;
        card.id = 'card-' + av.id;
        grid.appendChild(card);
    });
}

function toggleSelect(id) {
    if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
    const card = document.getElementById('card-' + id);
    if (card) card.classList.toggle('selected', selectedIds.has(id));
    document.getElementById('statSelected').textContent = selectedIds.size;
}

function selectAll() {
    const allSelected = selectedIds.size === avatars.length;
    selectedIds.clear();
    if (!allSelected) avatars.forEach(a => selectedIds.add(a.id));
    renderAvatars();
    document.getElementById('statSelected').textContent = selectedIds.size;
}

// ── Download (browser-native) ──
async function downloadSelected() {
    if (selectedIds.size === 0) { logMsg('No avatars selected', 'error'); return; }
    const toDownload = avatars.filter(a => selectedIds.has(a.id));

    for (const av of toDownload) {
        const card = document.getElementById('card-' + av.id);
        if (card) card.classList.add('downloading');

        let url = null;
        for (const pkg of (av.unityPackages || [])) {
            if ((pkg.platform === 'standalonewindows' || pkg.platform === 'pc') && pkg.assetUrl) {
                // Skip security-locked variants
                if (pkg.variant && pkg.variant.includes('security')) continue;
                url = pkg.assetUrl;
                break;
            }
        }

        if (!url) {
            logMsg(`⚠ ${av.name}: No PC asset URL found`, 'skip');
            if (card) { card.classList.remove('downloading'); card.classList.add('skipped'); }
            continue;
        }

        try {
            logMsg(`⬇ Downloading ${av.name}...`, 'info');

            // Build filename: 模型名_avtr_xxxx.vrca (sanitize for filesystem)
            const safeName = av.name.replace(/[\\/*?:"<>|]/g, '_');
            const filename = `${safeName}_${av.id}.vrca`;

            // Use Worker download proxy: same-origin, so Content-Disposition/filename works correctly
            // Auth passed as query param since <a>.click() can't send custom headers
            const proxyUrl = `${API_BASE}/api/download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}&auth=${encodeURIComponent(vrcAuth)}`;
            const a = document.createElement('a');
            a.href = proxyUrl;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            logMsg(`✓ ${av.name}: Download started → ${filename}`, 'success');
            if (card) { card.classList.remove('downloading'); card.classList.add('success'); }
            await new Promise(r => setTimeout(r, 800));
        } catch (e) {
            logMsg(`✗ ${av.name}: ${e.message}`, 'error');
            if (card) { card.classList.remove('downloading'); card.classList.add('skipped'); }
        }
    }
    logMsg('All downloads initiated!', 'success');
}


// ── Console ──
function logMsg(msg, type = 'info') {
    const el = document.getElementById('logConsole');
    const span = document.createElement('div');
    span.className = `log-${type}`;
    span.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    el.appendChild(span);
    el.scrollTop = el.scrollHeight;
}

// ── Upload Mode Toggle ──
document.querySelectorAll('input[name="uploadMode"]').forEach(r => {
    r.addEventListener('change', function () {
        document.getElementById('newFields').classList.toggle('hidden', this.value !== 'new');
        document.getElementById('updateFields').classList.toggle('hidden', this.value !== 'update');
    });
});

// ── File Selection / Drag ──
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');

if (dropZone) {
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => {
        e.preventDefault(); dropZone.classList.remove('dragover');
        addFiles(Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.vrca')));
    });
}
if (fileInput) {
    fileInput.addEventListener('change', () => { addFiles(Array.from(fileInput.files)); fileInput.value = ''; });
}

function addFiles(files) {
    files.forEach(f => { if (!uploadFiles.some(u => u.name === f.name)) uploadFiles.push(f); });
    renderFileList();
    document.getElementById('btnUpload').disabled = uploadFiles.length === 0;
}

function renderFileList() {
    const container = document.getElementById('file-list-container');
    const list = document.getElementById('file-list');
    if (uploadFiles.length === 0) { container.classList.add('hidden'); return; }
    container.classList.remove('hidden');
    list.innerHTML = uploadFiles.map((f, i) => `
        <div class="file-list-item" id="upload-item-${i}">
            <span class="file-name">${f.name}</span>
            <span class="file-size">${(f.size / 1048576).toFixed(1)} MB</span>
            <span class="file-status" id="upload-status-${i}"></span>
            <button class="file-remove" onclick="removeFile(${i})">×</button>
        </div>
    `).join('');
}

function removeFile(i) {
    uploadFiles.splice(i, 1);
    renderFileList();
    document.getElementById('btnUpload').disabled = uploadFiles.length === 0;
}

// (proxy input removed — CF Workers version uploads via /api/s3proxy)

// ── MD5 (using SubtleCrypto isn't available for MD5, use simple implementation) ──
function md5(buffer) {
    // Simple MD5 implementation for ArrayBuffer → base64
    const bytes = new Uint8Array(buffer);
    // Using SparkMD5-like approach inline
    return sparkMD5ArrayBuffer(bytes);
}

// Minimal MD5 for ArrayBuffer (adapted from SparkMD5)
function sparkMD5ArrayBuffer(uint8) {
    function md5cycle(x, k) {
        let a = x[0], b = x[1], c = x[2], d = x[3];
        a = ff(a, b, c, d, k[0], 7, -680876936); d = ff(d, a, b, c, k[1], 12, -389564586); c = ff(c, d, a, b, k[2], 17, 606105819); b = ff(b, c, d, a, k[3], 22, -1044525330);
        a = ff(a, b, c, d, k[4], 7, -176418897); d = ff(d, a, b, c, k[5], 12, 1200080426); c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983);
        a = ff(a, b, c, d, k[8], 7, 1770035416); d = ff(d, a, b, c, k[9], 12, -1958414417); c = ff(c, d, a, b, k[10], 17, -42063); b = ff(b, c, d, a, k[11], 22, -1990404162);
        a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101); c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
        a = gg(a, b, c, d, k[1], 5, -165796510); d = gg(d, a, b, c, k[6], 9, -1069501632); c = gg(c, d, a, b, k[11], 14, 643717713); b = gg(b, c, d, a, k[0], 20, -373897302);
        a = gg(a, b, c, d, k[5], 5, -701558691); d = gg(d, a, b, c, k[10], 9, 38016083); c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
        a = gg(a, b, c, d, k[9], 5, 568446438); d = gg(d, a, b, c, k[14], 9, -1019803690); c = gg(c, d, a, b, k[3], 14, -187363961); b = gg(b, c, d, a, k[8], 20, 1163531501);
        a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784); c = gg(c, d, a, b, k[7], 14, 1735328473); b = gg(b, c, d, a, k[12], 20, -1926607734);
        a = hh(a, b, c, d, k[5], 4, -378558); d = hh(d, a, b, c, k[8], 11, -2022574463); c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
        a = hh(a, b, c, d, k[1], 4, -1530992060); d = hh(d, a, b, c, k[4], 11, 1272893353); c = hh(c, d, a, b, k[7], 16, -155497632); b = hh(b, c, d, a, k[10], 23, -1094730640);
        a = hh(a, b, c, d, k[13], 4, 681279174); d = hh(d, a, b, c, k[0], 11, -358537222); c = hh(c, d, a, b, k[3], 16, -722521979); b = hh(b, c, d, a, k[6], 23, 76029189);
        a = hh(a, b, c, d, k[9], 4, -640364487); d = hh(d, a, b, c, k[12], 11, -421815835); c = hh(c, d, a, b, k[15], 16, 530742520); b = hh(b, c, d, a, k[2], 23, -995338651);
        a = ii(a, b, c, d, k[0], 6, -198630844); d = ii(d, a, b, c, k[7], 10, 1126891415); c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
        a = ii(a, b, c, d, k[12], 6, 1700485571); d = ii(d, a, b, c, k[3], 10, -1894986606); c = ii(c, d, a, b, k[10], 15, -1051523); b = ii(b, c, d, a, k[1], 21, -2054922799);
        a = ii(a, b, c, d, k[8], 6, 1873313359); d = ii(d, a, b, c, k[15], 10, -30611744); c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649);
        a = ii(a, b, c, d, k[4], 6, -145523070); d = ii(d, a, b, c, k[11], 10, -1120210379); c = ii(c, d, a, b, k[2], 15, 718787259); b = ii(b, c, d, a, k[9], 21, -343485551);
        x[0] = add32(a, x[0]); x[1] = add32(b, x[1]); x[2] = add32(c, x[2]); x[3] = add32(d, x[3]);
    }
    function cmn(q, a, b, x, s, t) { a = add32(add32(a, q), add32(x, t)); return add32((a << s) | (a >>> (32 - s)), b); }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
    function add32(a, b) { return (a + b) & 0xFFFFFFFF; }

    const n = uint8.length;
    let state = [1732584193, -271733879, -1732584194, 271733878];
    let i;
    for (i = 64; i <= n; i += 64) {
        const words = new Int32Array(uint8.buffer, uint8.byteOffset + i - 64, 16);
        md5cycle(state, words);
    }
    const tail = new Uint8Array(64);
    const remaining = n - (i - 64);
    for (let j = 0; j < remaining; j++) tail[j] = uint8[i - 64 + j];
    tail[remaining] = 0x80;
    if (remaining > 55) {
        md5cycle(state, new Int32Array(tail.buffer, 0, 16));
        tail.fill(0);
    }
    const bits = new DataView(tail.buffer);
    bits.setUint32(56, n * 8, true);
    bits.setUint32(60, 0, true);
    md5cycle(state, new Int32Array(tail.buffer, 0, 16));

    const result = new Uint8Array(16);
    for (let j = 0; j < 4; j++) {
        result[j * 4] = state[j] & 0xFF;
        result[j * 4 + 1] = (state[j] >> 8) & 0xFF;
        result[j * 4 + 2] = (state[j] >> 16) & 0xFF;
        result[j * 4 + 3] = (state[j] >> 24) & 0xFF;
    }
    return btoa(String.fromCharCode(...result));
}

// ── Gzip Compress ──
async function gzipCompress(data) {
    if (typeof CompressionStream !== 'undefined') {
        const cs = new CompressionStream('gzip');
        const writer = cs.writable.getWriter();
        writer.write(data);
        writer.close();
        const chunks = [];
        const reader = cs.readable.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
        }
        let totalLen = chunks.reduce((s, c) => s + c.length, 0);
        let result = new Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
        return result;
    }
    // Fallback: return as-is (no compression)
    return data instanceof Uint8Array ? data : new Uint8Array(data);
}

// ── Rsync Signature (BLAKE2 format) ──
async function computeRsyncSignature(fileData) {
    const blockSize = 2048;
    const strongSumLen = 32;
    const headerSize = 12;
    const numBlocks = Math.ceil(fileData.length / blockSize);
    const sigSize = headerSize + numBlocks * (4 + strongSumLen);
    const sig = new Uint8Array(sigSize);
    const view = new DataView(sig.buffer);

    // Header: magic(BLAKE2), block_size, strong_sum_len
    view.setUint32(0, 0x72730137);
    view.setUint32(4, blockSize);
    view.setUint32(8, strongSumLen);

    let offset = headerSize;
    for (let i = 0; i < fileData.length; i += blockSize) {
        const block = fileData.subarray(i, Math.min(i + blockSize, fileData.length));

        // Weak checksum (adler32-like, matching Python implementation)
        let s1 = 0, s2 = 0;
        for (let j = 0; j < block.length; j++) {
            s1 = (s1 + block[j] + 31) % 65536;
            s2 = (s2 + s1) % 65536;
        }
        const weak = ((s2 & 0xFFFF) << 16) | (s1 & 0xFFFF);
        view.setUint32(offset, weak);
        offset += 4;

        // Strong checksum (BLAKE2b-256) — use SubtleCrypto SHA-256 as fallback
        // Note: SubtleCrypto doesn't have BLAKE2, so we match the Python BLAKE2 output
        // For VRChat compatibility, we need actual BLAKE2b
        const hash = await blake2b256(block);
        sig.set(hash, offset);
        offset += strongSumLen;
    }
    return sig.subarray(0, offset);
}

// Minimal BLAKE2b-256 implementation
async function blake2b256(data) {
    // BLAKE2b constants
    const IV = new BigUint64Array([
        0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
        0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n
    ]);
    const SIGMA = [
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
        [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
        [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
        [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
        [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0]
    ];

    const outLen = 32;
    let h = new BigUint64Array(IV);
    h[0] ^= BigInt(0x01010000 ^ outLen);

    const blockSize = 128;
    let t = 0n;
    const pad = new Uint8Array(blockSize);

    function G(v, a, b, c, d, x, y) {
        v[a] = v[a] + v[b] + x; v[d] = rotr64(v[d] ^ v[a], 32n);
        v[c] = v[c] + v[d]; v[b] = rotr64(v[b] ^ v[c], 24n);
        v[a] = v[a] + v[b] + y; v[d] = rotr64(v[d] ^ v[a], 16n);
        v[c] = v[c] + v[d]; v[b] = rotr64(v[b] ^ v[c], 63n);
    }
    function rotr64(x, n) { return ((x >> n) | (x << (64n - n))) & 0xFFFFFFFFFFFFFFFFn; }

    function compress(block, t, last) {
        const m = new BigUint64Array(16);
        const dv = new DataView(block.buffer, block.byteOffset, blockSize);
        for (let i = 0; i < 16; i++) m[i] = dv.getBigUint64(i * 8, true);

        const v = new BigUint64Array(16);
        for (let i = 0; i < 8; i++) { v[i] = h[i]; v[i + 8] = IV[i]; }
        v[12] ^= t & 0xFFFFFFFFFFFFFFFFn;
        v[13] ^= (t >> 64n) & 0xFFFFFFFFFFFFFFFFn;
        if (last) v[14] ^= 0xFFFFFFFFFFFFFFFFn;

        for (let round = 0; round < 12; round++) {
            const s = SIGMA[round % 10];
            G(v, 0, 4, 8, 12, m[s[0]], m[s[1]]); G(v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
            G(v, 2, 6, 10, 14, m[s[4]], m[s[5]]); G(v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
            G(v, 0, 5, 10, 15, m[s[8]], m[s[9]]); G(v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
            G(v, 2, 7, 8, 13, m[s[12]], m[s[13]]); G(v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
        }
        for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
    }

    let pos = 0;
    while (pos + blockSize <= data.length) {
        if (pos + blockSize < data.length) {
            t += BigInt(blockSize);
            compress(data.subarray(pos, pos + blockSize), t, false);
        } else {
            break;
        }
        pos += blockSize;
    }

    // Final block
    pad.fill(0);
    const remaining = data.length - pos;
    for (let i = 0; i < remaining; i++) pad[i] = data[pos + i];
    t += BigInt(remaining);
    compress(pad, t, true);

    const out = new Uint8Array(outLen);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 4; i++) outView.setBigUint64(i * 8, h[i], true);
    return out;
}

// ── Upload Logic ──
function setUploadStatus(msg, type = '') {
    const el = document.getElementById('upload-status');
    el.textContent = msg;
    el.className = 'upload-status' + (type ? ' ' + type : '');
}

function setProgress(pct, text) {
    const container = document.getElementById('upload-progress');
    const fill = document.getElementById('upload-progress-fill');
    const txt = document.getElementById('upload-progress-text');
    container.classList.toggle('active', pct >= 0);
    fill.style.width = pct + '%';
    if (text) txt.textContent = text;
}

async function startUpload() {
    if (uploadFiles.length === 0) return;
    const btn = document.getElementById('btnUpload');
    btn.disabled = true;
    const isNew = document.getElementById('modeNew').checked;

    setUploadStatus(t('uploading'));
    setProgress(0, '');

    for (let idx = 0; idx < uploadFiles.length; idx++) {
        const file = uploadFiles[idx];
        const itemEl = document.getElementById('upload-item-' + idx);
        const statusEl = document.getElementById('upload-status-' + idx);
        if (itemEl) itemEl.classList.add('uploading');
        if (statusEl) statusEl.textContent = '⏳';

        try {
            setUploadStatus(`Processing ${file.name}...`);
            const fileData = new Uint8Array(await file.arrayBuffer());

            // 1. Gzip compress the file
            setProgress(5, 'Compressing...');
            const fileGz = await gzipCompress(fileData);
            const fileGzMd5 = md5(fileGz);

            // 2. Compute rsync signature
            setProgress(10, 'Computing signature...');
            const sigBytes = await computeRsyncSignature(fileData);
            const sigGz = await gzipCompress(sigBytes);
            const sigGzMd5 = md5(sigGz);

            // 3. Create file & version via Worker proxy
            setProgress(15, 'Creating file version...');
            let fileId, versionId;

            if (isNew) {
                let name = uploadFiles.length === 1 ? document.getElementById('avatarName').value.trim() : '';
                if (!name) name = file.name.replace(/\.vrca$/i, '');

                // Create file record
                const rFile = await apiCall('/api/vrc/file', {
                    method: 'POST', json: { name, mimeType: 'application/x-avatar', extension: 'vrca', tags: [] }
                });
                if (!rFile.ok) throw new Error('Failed to create file: ' + await rFile.text());
                const fileData2 = await rFile.json();
                fileId = fileData2.id;

                // Create version
                const rVer = await apiCall(`/api/vrc/file/${fileId}`, {
                    method: 'POST', json: {
                        signatureMd5: sigGzMd5, signatureSizeInBytes: sigGz.length,
                        fileMd5: fileGzMd5, fileSizeInBytes: fileGz.length,
                    }
                });
                if (!rVer.ok) throw new Error('Failed to create version: ' + await rVer.text());
                const verData = await rVer.json();
                versionId = verData.versions[verData.versions.length - 1].version;
            } else {
                const avatarId = document.getElementById('avatarSelect').value;
                if (!avatarId) throw new Error('No avatar selected');

                // Get avatar info to find file ID
                const rAv = await apiCall(`/api/vrc/avatars/${avatarId}`);
                const avData = await rAv.json();
                for (const pkg of (avData.unityPackages || [])) {
                    if (['standalonewindows', 'pc'].includes(pkg.platform)) {
                        const m = (pkg.assetUrl || '').match(/file\/(file_[a-f0-9-]+)\//);
                        if (m) { fileId = m[1]; break; }
                    }
                }
                if (!fileId) throw new Error('Could not find file ID');

                const rVer = await apiCall(`/api/vrc/file/${fileId}`, {
                    method: 'POST', json: {
                        signatureMd5: sigGzMd5, signatureSizeInBytes: sigGz.length,
                        fileMd5: fileGzMd5, fileSizeInBytes: fileGz.length,
                    }
                });
                if (!rVer.ok) throw new Error('Failed to create version: ' + await rVer.text());
                const verData = await rVer.json();
                versionId = verData.versions[verData.versions.length - 1].version;
            }

            // 4. Upload signature via Worker proxy (avoids S3 CORS)
            setProgress(20, 'Uploading signature...');
            const rSigStart = await apiCall(`/api/vrc/file/${fileId}/${versionId}/signature/start`, { method: 'PUT' });
            if (!rSigStart.ok) throw new Error('Failed to start sig upload: ' + await rSigStart.text());
            const sigUrl = (await rSigStart.json()).url;

            // Proxy S3 PUT through Worker to bypass CORS
            const rSigPut = await fetch(`${API_BASE}/api/s3proxy`, {
                method: 'PUT',
                body: sigGz,
                headers: {
                    'X-S3-Url': sigUrl,
                    // content-md5 lowercase to match X-Amz-SignedHeaders value (AWS SigV4 always lowercase)
                    'X-S3-content-md5': sigGzMd5,
                    'X-S3-content-type': 'application/gzip',
                    'X-VRC-Auth': vrcAuth,
                },
            });
            if (!rSigPut.ok) {
                const errText = await rSigPut.text();
                throw new Error('Signature S3 upload failed: ' + errText.substring(0, 200));
            }

            // Finish signature
            const rSigFinish = await apiCall(`/api/vrc/file/${fileId}/${versionId}/signature/finish`, {
                method: 'PUT', json: { nextPartNumber: '0', maxParts: '0' }
            });
            if (!rSigFinish.ok) {
                // Retry with empty etags
                const retry = await apiCall(`/api/vrc/file/${fileId}/${versionId}/signature/finish`, {
                    method: 'PUT', json: { etags: [], nextPartNumber: '0', maxParts: '0' }
                });
                if (!retry.ok) throw new Error('Failed to finalize signature: ' + await retry.text());
            }

            // 5. Upload file (multipart, 10MB chunks) — DIRECT TO S3!
            setProgress(25, 'Uploading file...');
            const CHUNK_SIZE = 10 * 1024 * 1024;
            const totalParts = Math.ceil(fileGz.length / CHUNK_SIZE);
            const etags = [];

            for (let partNum = 1; partNum <= totalParts; partNum++) {
                const pOffset = (partNum - 1) * CHUNK_SIZE;
                const chunk = fileGz.subarray(pOffset, Math.min(pOffset + CHUNK_SIZE, fileGz.length));

                const rPartStart = await apiCall(`/api/vrc/file/${fileId}/${versionId}/file/start?partNumber=${partNum}`, { method: 'PUT' });
                if (!rPartStart.ok) throw new Error(`Part ${partNum} start failed: ` + await rPartStart.text());
                const partUrl = (await rPartStart.json()).url;

                // Proxy S3 PUT through Worker (no direct S3 CORS needed)
                const pctBefore = 25 + ((partNum - 1) / totalParts) * 70;
                const pctAfter = 25 + (partNum / totalParts) * 70;
                const uploadedBefore = pOffset / 1048576;
                const totalMB = fileGz.length / 1048576;
                setProgress(pctBefore, `Part ${partNum}/${totalParts}: ${uploadedBefore.toFixed(1)}/${totalMB.toFixed(1)} MB`);

                const rPartPut = await fetch(`${API_BASE}/api/s3proxy`, {
                    method: 'PUT',
                    body: chunk,
                    headers: {
                        'X-S3-Url': partUrl,
                        'X-VRC-Auth': vrcAuth,
                    },
                });
                if (!rPartPut.ok) {
                    const errText = await rPartPut.text();
                    throw new Error(`S3 part ${partNum} failed: ` + errText.substring(0, 200));
                }
                const partJson = await rPartPut.json();
                if (partJson.etag) etags.push(partJson.etag);

                setProgress(pctAfter, `Part ${partNum}/${totalParts}: ${((pOffset + chunk.length) / 1048576).toFixed(1)}/${totalMB.toFixed(1)} MB`);
            }

            // 6. Finish file upload
            setProgress(95, 'Finalizing...');
            const rFileFinish = await apiCall(`/api/vrc/file/${fileId}/${versionId}/file/finish`, {
                method: 'PUT', json: { etags, nextPartNumber: '0', maxParts: '0' }
            });
            if (!rFileFinish.ok) throw new Error('Failed to finalize file: ' + await rFileFinish.text());

            // 7. Wait for file status to become 'complete' before creating avatar
            // GET /file/{fileId}/{versionId} returns the version object directly with a `.status` field
            setProgress(97, 'Waiting for file to be processed...');
            let fileReady = false;
            for (let attempt = 0; attempt < 20; attempt++) {
                await new Promise(r => setTimeout(r, 2000));
                const rStatus = await apiCall(`/api/vrc/file/${fileId}/${versionId}`);
                if (rStatus.ok) {
                    const ver = await rStatus.json();
                    const status = ver.status || 'unknown';
                    logMsg(`Attempt ${attempt + 1}/20 — status: ${status}`, 'info');
                    if (status === 'complete') {
                        fileReady = true;
                        break;
                    }
                    if (status === 'error') {
                        throw new Error(`File processing failed with status: error`);
                    }
                } else {
                    logMsg(`Attempt ${attempt + 1}/20 — poll failed (${rStatus.status})`, 'info');
                }
            }
            if (!fileReady) throw new Error('File not ready after 40s. It may still be processing — wait a moment and try the Update mode instead of New.');

            // 8. Create/update avatar
            if (isNew) {
                let name = uploadFiles.length === 1 ? document.getElementById('avatarName').value.trim() : '';
                if (!name) name = file.name.replace(/\.vrca$/i, '');

                const rAvatar = await apiCall('/api/vrc/avatars', {
                    method: 'POST', json: {
                        name,
                        assetUrl: `https://api.vrchat.cloud/api/1/file/${fileId}/${versionId}/file`,
                        imageUrl: 'https://api.vrchat.cloud/api/1/file/file_0e8c4e32-7444-44ea-ade4-8c2d1ce47b68/1/file',
                        releaseStatus: 'private',
                        unityPackageUrl: '',
                        unityVersion: '2022.3.22f1',
                        platform: 'standalonewindows',
                        description: 'Uploaded via VRChat Asset Manager',
                        tags: [],
                    }
                });
                if (!rAvatar.ok) throw new Error('Failed to create avatar: ' + await rAvatar.text());
            }

            setProgress(100, 'Done!');
            if (statusEl) statusEl.textContent = '✓';
            if (itemEl) { itemEl.classList.remove('uploading'); itemEl.classList.add('done'); }
            setUploadStatus(t('uploadOk'), 'success');

        } catch (e) {
            if (statusEl) statusEl.textContent = '✗';
            if (itemEl) { itemEl.classList.remove('uploading'); itemEl.classList.add('error'); }
            setUploadStatus(t('uploadFail') + e.message, 'error');
        }
    }
    btn.disabled = false;
}

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
    setLang(currentLang);
    // Auto-login if we have saved auth
    if (vrcAuth) {
        apiCall('/api/vrc/auth/user').then(r => {
            if (r.ok) showMainApp();
        }).catch(() => { });
    }
});
