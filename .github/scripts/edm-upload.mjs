#!/usr/bin/env node
// upload.mjs — 上传文件到阿里云盘企业版(CDE/EDM, PDS v2 API)
// 协议逆向自 EDM 客户端与官方 pds-js-sdk, 零依赖, Node >= 18。
// 既可被 action.yml 以环境变量调用, 也可命令行独立使用。
//
// 环境变量(与 action.yml inputs 对应):
//   INPUT_TOKEN / INPUT_FILES / INPUT_DRIVE_ID / INPUT_PARENT_PATH / INPUT_PARENT_FILE_ID
//   INPUT_CHECK_NAME_MODE / INPUT_CONCURRENCY / INPUT_API_ENDPOINT / INPUT_CLIENT_ID / INPUT_PART_SIZE
// 命令行:
//   node upload.mjs --token '<json或refresh_token>' --files 'dist/*.zip' [--drive-id 1]
//                   [--parent-path /ci] [--check-name-mode auto_rename] [--concurrency 3] [--selftest]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

// ================= CRC-64/XZ (ECMA-182, poly 0xC96C5795D7870F42) =================
const CRC64_TABLE = (() => {
  const POLY = 0xC96C5795D7870F42n;
  const table = new Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = BigInt(i);
    for (let j = 0; j < 8; j++) crc = crc & 1n ? (crc >> 1n) ^ POLY : crc >> 1n;
    table[i] = crc;
  }
  return table;
})();
const CRC64_INIT = 0xFFFFFFFFFFFFFFFFn;
const CRC64_XOROUT = 0xFFFFFFFFFFFFFFFFn;
function crc64Update(crc, buf) {
  let c = crc;
  for (let i = 0; i < buf.length; i++) c = CRC64_TABLE[Number((c ^ BigInt(buf[i])) & 0xFFn)] ^ (c >> 8n);
  return c;
}
function crc64File(file) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    let crc = CRC64_INIT;
    stream.on('data', (d) => { crc = crc64Update(crc, d); });
    stream.on('end', () => resolve(((crc ^ CRC64_XOROUT) & 0xFFFFFFFFFFFFFFFFn).toString(10)));
    stream.on('error', reject);
  });
}

// ================= 哈希(单遍流: sha1 + 可选 crc64) =================
async function hashFile(file, { sha1 = true, crc64 = true } = {}) {
  const h = sha1 ? crypto.createHash('sha1') : null;
  let crc = CRC64_INIT;
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) {
    if (h) h.update(chunk);
    if (crc64) crc = crc64Update(crc, chunk);
  }
  return {
    sha1: h ? h.digest('hex').toUpperCase() : null,
    crc64: crc64 ? ((crc ^ CRC64_XOROUT) & 0xFFFFFFFFFFFFFFFFn).toString(10) : null,
  };
}

// ================= 参数 =================
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = (s) => s.replace(/-/g, '_'); // --part-size 与 --part_size 等价
      const eq = a.indexOf('=');
      if (eq !== -1) args[key(a.slice(2, eq))] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[key(a.slice(2))] = argv[++i];
      else args[key(a.slice(2))] = true;
    }
  }
  return args;
}
const CLI = parseArgs(process.argv.slice(2));
const env = (k, d = '') => (CLI[k] !== undefined ? String(CLI[k]) : process.env[`INPUT_${k.toUpperCase()}`] ?? d);
function die(msg) { console.error(`::error::${msg}`); process.exit(1); }

const CFG = {
  token: env('token'),
  files: env('files'),
  driveId: env('drive_id'),
  driveName: env('drive_name'),
  parentPath: env('parent_path', '/'),
  parentFileId: env('parent_file_id'),
  checkNameMode: env('check_name_mode', 'auto_rename'),
  concurrency: Math.max(1, parseInt(env('concurrency', '3'), 10) || 1),
  apiEndpoint: env('api_endpoint'),
  clientId: env('client_id', 'EdmpX4opdRNI9feB'),
  partSize: Math.max(1024 * 1024, parseInt(env('part_size', String(10 * 1024 * 1024)), 10) || 10 * 1024 * 1024),
};

// ================= HTTP =================
async function apiPost(ep, path, body, token) {
  const res = await fetch(`${ep}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-requested-with': 'xmlhttprequest',
      'User-Agent': 'edm-upload-action/1.0',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status} ${path}: ${text.slice(0, 300)}`);
    e.status = res.status;
    e.body = json || text;
    throw e;
  }
  return json;
}

// ================= token 处理 =================
function parseToken(raw) {
  let t = null;
  try { t = JSON.parse(raw); } catch { t = { refresh_token: raw }; }
  if (typeof t !== 'object' || !t) t = { refresh_token: String(raw) };
  return t;
}
function tokenExpired(t, skewSec = 90) {
  if (t.expire_time) return Date.parse(t.expire_time) - skewSec * 1000 < Date.now();
  if (t.expires_in) return true; // 没有绝对时间就当作需要刷新
  return true;
}
async function ensureToken(t) {
  if (t.access_token && !tokenExpired(t)) return t.access_token;
  if (!t.refresh_token) die('token 里没有 access_token(未过期)也没有 refresh_token');
  if (!t.domain_id) die('token 里没有 domain_id, 无法发现端点');
  const disc = await discoverEndpoints(t.domain_id);
  // 抓包实证: 刷新走 {auth_endpoint}/v2/account/token (JSON), refresh_token 每次轮换
  const res = await fetch(`${disc.auth_endpoint}/v2/account/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: CFG.clientId,
      refresh_token: t.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const text = await res.text();
  let fresh = null;
  try { fresh = JSON.parse(text); } catch { /* ignore */ }
  if (!fresh?.access_token) die(`刷新 token 失败(refresh_token 可能已失效, 请重新运行 edm-token login): ${text.slice(0, 300)}`);
  const expMs = fresh.expire_time ? Date.parse(fresh.expire_time) : Date.now() + (fresh.expires_in || 7200) * 1000;
  const rotated = fresh.refresh_token;
  if (rotated && rotated !== t.refresh_token) {
    console.log(`::warning::refresh_token 已轮换, 请更新 GitHub Secret! 新 refresh_token: ${rotated}`);
    // GitHub Actions 输出供后续步骤更新 secret
    const outFile = process.env.GITHUB_OUTPUT;
    if (outFile) fs.appendFileSync(outFile, `refresh_token=${rotated}\n`);
  }
  return fresh.access_token;
}

async function discoverEndpoints(domainId) {
  const res = await fetch('https://web-sv.aliyunpds.com/endpoint/get_endpoints', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain_id: domainId, is_vpc: false }),
  });
  const d = await res.json();
  if (!d?.api_endpoint) die(`endpoint 发现失败(domain=${domainId}): ${JSON.stringify(d).slice(0, 200)}`);
  return d;
}

// ================= 目录解析 =================
async function resolveDrive(api, token) {
  if (CFG.driveId) return CFG.driveId;
  // 抓包实证: CDE 用 list_my_group_drive, 默认主空间是 root_group_drive(不在 items 里)
  const d = await apiPost(api, '/v2/drive/list_my_group_drive', {}, token);
  const root = d.root_group_drive;
  const items = d.items || [];
  if (CFG.driveName) {
    // 按名字选团队空间(精确匹配; 团队空间在 items 里, 主空间在 root_group_drive)
    const all = root ? [root, ...items] : items;
    const hit = all.find((x) => x.drive_name === CFG.driveName);
    if (!hit) {
      const names = all.map((x) => `${x.drive_name}(${x.drive_id})`).join(', ');
      die(`找不到团队空间 "${CFG.driveName}"。可选: ${names}`);
    }
    console.log(`使用空间: ${hit.drive_name} (drive_id=${hit.drive_id})`);
    return hit.drive_id;
  }
  const pick = root || items[0];
  if (!pick) die('该企业下没有可用空间(drive)');
  console.log(`使用空间: ${pick.drive_name || pick.drive_id} (drive_id=${pick.drive_id})`);
  return pick.drive_id;
}

async function findChildFolder(api, token, driveId, parentId, name) {
  let marker = '';
  for (let page = 0; page < 50; page++) {
    const d = await apiPost(api, '/v2/file/list', { drive_id: driveId, parent_file_id: parentId, limit: 100, marker }, token);
    const items = d.items || [];
    const hit = items.find((x) => x.name === name && x.type === 'folder');
    if (hit) return hit.file_id;
    marker = d.next_marker;
    if (!marker) break;
  }
  return null;
}

async function resolveParentId(api, token, driveId) {
  if (CFG.parentFileId) return CFG.parentFileId;
  let pid = 'root';
  const segs = CFG.parentPath.split('/').filter(Boolean);
  for (const seg of segs) {
    const found = await findChildFolder(api, token, driveId, pid, seg);
    if (found) { pid = found; continue; }
    console.log(`创建目录: ${seg}`);
    const d = await apiPost(api, '/v2/file/create', {
      drive_id: driveId, parent_file_id: pid, name: seg, type: 'folder', check_name_mode: 'ignore',
    }, token);
    pid = d.file_id;
    if (!pid) die(`创建目录失败: ${seg} ${JSON.stringify(d).slice(0, 200)}`);
  }
  return pid;
}

// ================= 上传 =================
async function putPart(url, buf, contentType, retries = 3) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: 'PUT',
      // content_type 必须与服务端 part_info_list 给的一致(含空串), 否则预签名报 SignatureDoesNotMatch
      headers: { 'Content-Type': contentType ?? '', 'Content-Length': String(buf.length) },
      body: buf,
    });
    const body = await res.text().catch(() => ''); // 消费响应体以复用连接
    if (res.status === 403 && attempt <= retries) {
      if (/expired/i.test(body)) { const e = new Error('upload_url expired'); e.expired = true; throw e; }
    } else if (!res.ok) {
      if (attempt > retries) throw new Error(`PUT 分片失败 HTTP ${res.status}: ${body.slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, attempt * 1000));
    } else {
      // etag 原样使用(带引号)! complete 服务端按带引号字符串比对, 去掉引号会报 Etag not matched
      const etag = res.headers.get('etag');
      if (!etag) throw new Error('PUT 响应缺少 etag');
      return etag;
    }
  }
}

async function uploadOne(api, token, driveId, parentId, file) {
  const size = fs.statSync(file).size;
  const name = path.basename(file);
  console.log(`\n=== 上传 ${name} (${(size / 1024 / 1024).toFixed(2)} MB) ===`);
  const t0 = Date.now();
  const { sha1, crc64 } = await hashFile(file);
  console.log(`SHA1=${sha1} CRC64=${crc64} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // 分片数上限 9000(与官方客户端一致), 超过则放大分片并对齐 64 字节; 单片上限 5GB
  let partSize = CFG.partSize;
  if (size / partSize > 9000) partSize = Math.ceil(size / 9000 / 64) * 64;
  partSize = Math.min(partSize, 5 * 1024 * 1024 * 1024);
  const partCount = Math.max(1, Math.ceil(size / partSize));
  const partInfoList = Array.from({ length: partCount }, (_, i) => ({ part_number: i + 1, part_size: partSize }));

  const created = await apiPost(api, '/v2/file/create', {
    drive_id: driveId,
    parent_file_id: parentId,
    name,
    type: 'file',
    size,
    content_type: 'application/octet-stream',
    content_hash_name: 'sha1',
    content_hash: sha1,
    part_info_list: partInfoList,
    check_name_mode: CFG.checkNameMode,
  }, token);

  if (created.rapid_upload) {
    console.log(`秒传成功: ${name} → file_id=${created.file_id}`);
    return { name, file_id: created.file_id, drive_id: driveId, size, sha1, rapid_upload: true };
  }
  if (created.exist) {
    // check_name_mode=ignore 且已存在: 服务端直接返回已有文件
    console.log(`文件已存在(ignore): ${name} → file_id=${created.file_id}`);
    return { name, file_id: created.file_id, drive_id: driveId, size, sha1, rapid_upload: false, existed: true };
  }
  if (!created.upload_id) die(`create 未返回 upload_id: ${JSON.stringify(created).slice(0, 300)}`);

  const { upload_id: uploadId, file_id: fileId } = created;
  let parts = created.part_info_list || [];

  const refreshUrls = async () => {
    const d = await apiPost(api, '/v2/file/get_upload_url', {
      drive_id: driveId, file_id: fileId, upload_id: uploadId,
      part_info_list: partInfoList.map((p) => ({ part_number: p.part_number })),
    }, token);
    parts = d.part_info_list || parts;
  };

  // 分片 PUT(带并发; upload_url 过期整体刷新重试)
  const etags = new Array(partCount);
  const queue = [...parts.keys()];
  let failed = null;
  const workers = Array.from({ length: Math.min(CFG.concurrency, partCount) }, async () => {
    while (queue.length && !failed) {
      const i = queue.shift();
      const part = parts[i];
      const start = i * partSize;
      const buf = Buffer.alloc(Math.min(partSize, size - start));
      await readRange(file, start, buf);
      for (let attempt = 0; ; attempt++) {
        try {
          etags[i] = await putPart(part.upload_url || part.internal_upload_url, buf, part.content_type);
          break;
        } catch (e) {
          if (e.expired && attempt < 3) { console.log(`分片 ${i + 1} URL 过期, 刷新重试...`); await refreshUrls(); continue; }
          failed = e; break;
        }
      }
      const done = etags.filter(Boolean).length;
      console.log(`分片 ${done}/${partCount}`);
    }
  });
  await Promise.all(workers);
  if (failed) throw failed;

  const done = await apiPost(api, '/v2/file/complete', {
    drive_id: driveId,
    file_id: fileId,
    upload_id: uploadId,
    part_info_list: etags.map((etag, i) => ({ part_number: i + 1, etag })),
    crc64_hash: crc64,
  }, token);
  console.log(`完成: ${name} → file_id=${fileId} status=${done.status || 'available'} 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { name, file_id: fileId, drive_id: driveId, size, sha1, rapid_upload: false };
}

function readRange(file, start, buf) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file, { start, end: start + buf.length - 1 });
    let off = 0;
    stream.on('data', (d) => { d.copy(buf, off); off += d.length; });
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
}

// ================= mini glob =================
function globToRegExp(glob) {
  const normalized = glob.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i];
    if (c === '*') {
      if (normalized[i + 1] === '*') { re += '.*'; i++; if (normalized[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
function expandFiles(patterns, cwd) {
  const out = new Set();
  for (const raw of patterns) {
    const pat = raw.trim();
    if (!pat) continue;
    if (!/[*?]/.test(pat)) {
      const p = path.resolve(cwd, pat);
      if (fs.existsSync(p)) out.add(p); else console.log(`::warning::路径不存在, 跳过: ${pat}`);
      continue;
    }
    const abs = path.resolve(cwd, pat).replace(/\\/g, '/');
    const baseSeg = abs.split('/').filter(Boolean);
    let base = path.parse(abs).root || cwd;
    for (const seg of baseSeg) { if (/[*?]/.test(seg)) break; base = path.join(base, seg); }
    if (!fs.existsSync(base)) { console.log(`::warning::glob 基路径不存在, 跳过: ${pat}`); continue; }
    const re = globToRegExp(path.isAbsolute(pat) ? pat.replace(/\\/g, '/') : pat.replace(/\\/g, '/'));
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) { if (ent.name !== '.git' && ent.name !== 'node_modules') walk(full); }
        else {
          const rel = path.relative(cwd, full).replace(/\\/g, '/');
          if (re.test(rel) || re.test(full.replace(/\\/g, '/'))) out.add(full);
        }
      }
    };
    walk(base);
  }
  return [...out].sort();
}

// ================= selftest =================
async function selftest() {
  // CRC-64/XZ 标准测试向量: "123456789" -> 0x995DC9BBDF1939FA
  const v = crc64Update(CRC64_INIT, Buffer.from('123456789'));
  const got = ((v ^ CRC64_XOROUT) & 0xFFFFFFFFFFFFFFFFn).toString(16);
  console.log(`crc64("123456789") = 0x${got} (期望 995dc9bbdf1939fa) ${got === '995dc9bbdf1939fa' ? 'OK' : 'FAIL'}`);
  const tmp = path.join(process.env.TEMP || '/tmp', `edm-selftest-${Date.now()}.bin`);
  fs.writeFileSync(tmp, crypto.randomBytes(1024 * 1024 + 7));
  const h = await hashFile(tmp);
  console.log(`sha1(1MB+7B) = ${h.sha1} crc64 = ${h.crc64}`);
  const re = globToRegExp('dist/**/*.zip');
  console.log(`glob dist/**/*.zip vs dist/a/b/c.zip: ${re.test('dist/a/b/c.zip')} (期望 true)`);
  const re2 = globToRegExp('dist/*.zip');
  console.log(`glob dist/*.zip vs dist/a/b/c.zip: ${re2.test('dist/a/b/c.zip')} (期望 false)`);
  fs.unlinkSync(tmp);
  process.exit(got === '995dc9bbdf1939fa' ? 0 : 1);
}

// ================= main =================
async function main() {
  if (CLI.selftest) return selftest();
  if (!CFG.token) die('缺少 token (INPUT_TOKEN)');
  if (!CFG.files) die('缺少 files (INPUT_FILES)');

  const tokenObj = parseToken(CFG.token.trim());
  const accessToken = await ensureToken(tokenObj);
  const api = CFG.apiEndpoint || (tokenObj.domain_id ? (await discoverEndpoints(tokenObj.domain_id)).api_endpoint : null);
  if (!api) die('无法确定 api_endpoint: 请在 token JSON 里带 domain_id, 或显式提供 api_endpoint');

  const cwd = process.env.GITHUB_WORKSPACE || process.cwd();
  const files = expandFiles(CFG.files.split('\n').flatMap((s) => s.split(' ')), cwd);
  if (!files.length) die(`没有匹配到任何文件: ${CFG.files}`);

  const driveId = await resolveDrive(api, accessToken);
  const parentId = await resolveParentId(api, accessToken, driveId);
  console.log(`目标目录 file_id=${parentId}, 共 ${files.length} 个文件`);

  const results = [];
  for (const f of files) {
    results.push(await uploadOne(api, accessToken, driveId, parentId, f));
  }
  console.log('\n=== 全部完成 ===');
  console.log(JSON.stringify(results, null, 2));
  const outFile = process.env.GITHUB_OUTPUT;
  if (outFile) fs.appendFileSync(outFile, `results=${JSON.stringify(JSON.stringify(results))}\n`);
}

main().catch((e) => die(e.stack || String(e)));
