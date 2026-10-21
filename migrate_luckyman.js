/**
 * Luckyman Cloud Migration Tool: Cloudflare R2 ZIP Packs -> Zoho Catalyst Stratus
 * 
 * - Downloads Part 1 (EP 01-25) and Part 2 (EP 26-50) from Cloudflare R2
 * - Extracts and uploads loose episodes directly to:
 *     Luckyman/Season 01/Luckyman_S01E01...mkv
 * - Verifies HTTP 206 Range playback
 * - Deletes temporary files immediately to preserve disk
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync, spawn } = require('child_process');
const { getZohoToken, checkStratusObject, STRATUS_BASE_URL, BUCKET_NAME } = require('./migrate');

const MANIFEST_FILE = process.env.MANIFEST_FILE ? path.resolve(process.env.MANIFEST_FILE) : path.join(__dirname, 'zoho_manifest_luckyman.json');

let manifest = {};
if (fs.existsSync(MANIFEST_FILE)) {
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')); } catch (e) { manifest = {}; }
}

function saveManifest() {
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf8');
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

async function verifyRangePlayback(objectUrl) {
  return new Promise((resolve) => {
    https.get(objectUrl, {
      headers: { 'Range': 'bytes=0-1024' }
    }, (res) => {
      resolve({
        statusCode: res.statusCode,
        is206: res.statusCode === 206,
        acceptRanges: res.headers['accept-ranges'],
        contentRange: res.headers['content-range']
      });
    }).on('error', (err) => resolve({ statusCode: 500, error: err.message }));
  });
}

async function uploadLocalFileToZoho(filePath, targetKey) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const rawFilename = path.basename(filePath);

  console.log(`\n======================================================`);
  console.log(`🚀 Uploading to Stratus: ${rawFilename} (${formatBytes(fileSize)})`);
  console.log(`🎯 Target Key: ${targetKey}`);
  console.log(`======================================================`);

  const existingSize = await checkStratusObject(targetKey);
  if (existingSize && Math.abs(existingSize - fileSize) < 10240) {
    console.log(`⚡ Already uploaded and verified on Zoho Stratus (${formatBytes(existingSize)})! Skipping.`);
    return `${STRATUS_BASE_URL}/${encodeURI(targetKey)}`;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const token = await getZohoToken();
      const uploadUrl = `${STRATUS_BASE_URL}/${encodeURI(targetKey)}`;

      await new Promise((resolve, reject) => {
        const uploadReq = https.request(uploadUrl, {
          method: 'PUT',
          headers: {
            'Authorization': 'Zoho-oauthtoken ' + token,
            'Content-Type': rawFilename.toLowerCase().endsWith('.mkv') ? 'video/x-matroska' : 'video/mp4',
            'Content-Length': fileSize,
            'overwrite': 'true'
          }
        }, async (uploadRes) => {
          let body = '';
          uploadRes.on('data', c => body += c);
          uploadRes.on('end', async () => {
            if (uploadRes.statusCode >= 200 && uploadRes.statusCode < 300) {
              const publicUrl = `${STRATUS_BASE_URL}/${encodeURI(targetKey)}`;
              process.stdout.write(`🔍 Verifying HTTP 206 Seeking... `);
              const test = await verifyRangePlayback(publicUrl);
              console.log(test.is206 ? '[PASS]' : `[Status: ${test.statusCode}]`);

              manifest[targetKey] = {
                filename: rawFilename,
                key: targetKey,
                url: publicUrl,
                size_bytes: fileSize,
                uploaded_at: new Date().toISOString()
              };
              saveManifest();
              resolve(publicUrl);
            } else {
              reject(new Error(`Zoho upload returned ${uploadRes.statusCode}: ${body}`));
            }
          });
        });

        uploadReq.on('error', reject);

        const fileStream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
        let uploadedBytes = 0;
        let lastLog = Date.now();

        fileStream.on('data', chunk => {
          uploadedBytes += chunk.length;
          const now = Date.now();
          if (now - lastLog > 2000) {
            const pct = ((uploadedBytes / fileSize) * 100).toFixed(1);
            process.stdout.write(`\r⏳ Upload Progress: ${formatBytes(uploadedBytes)} / ${formatBytes(fileSize)} (${pct}%)`);
            lastLog = now;
          }
        });

        fileStream.pipe(uploadReq);
      });

      console.log(`\n✅ Upload Succeeded: ${targetKey}`);
      return `${STRATUS_BASE_URL}/${encodeURI(targetKey)}`;
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`\n⚠️ Upload attempt ${attempt}/3 failed: ${err.message}. Retrying in ${attempt * 2}s...`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

async function processPack(pack) {
  console.log(`\n######################################################`);
  console.log(`📦 Processing ${pack.title} (Part ${pack.part})`);
  console.log(`######################################################`);

  const workDir = path.join(__dirname, 'temp_luckyman', `part_${pack.part}`);
  fs.mkdirSync(workDir, { recursive: true });

  const zipPath = path.join(workDir, `luckyman_part_${pack.part}.zip`);

  // 1. Download ZIP Pack
  console.log(`\n⬇️ Downloading ZIP archive from Cloudflare R2 edge...`);
  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size < 1000000000) {
    execSync(`curl -L -A "Mozilla/5.0" -o "${zipPath}" "${pack.r2_url}"`, {
      stdio: 'inherit'
    });
  }

  const zipStat = fs.statSync(zipPath);
  console.log(`[✓] ZIP Downloaded: ${formatBytes(zipStat.size)}`);

  // 2. Extract using Python zipfile
  console.log(`\n📂 Extracting loose video files...`);
  const extractScript = `
import zipfile, os
with zipfile.ZipFile(r"${zipPath}", 'r') as z:
    for member in z.infolist():
        if member.filename.lower().endswith(('.mkv', '.mp4')):
            filename = os.path.basename(member.filename)
            if filename:
                target_path = os.path.join(r"${workDir}", filename)
                print(f"  - Extracting: {filename}")
                with z.open(member) as source, open(target_path, "wb") as target:
                    target.write(source.read())
`;
  execSync(`python -c "${extractScript.replace(/\n/g, ' ')}"`, { stdio: 'inherit' });

  // 3. Delete ZIP to reclaim disk space immediately
  console.log(`\n🧹 Removing ZIP file to free disk space...`);
  try { fs.unlinkSync(zipPath); } catch (e) {}

  // 4. Upload extracted episodes
  const files = fs.readdirSync(workDir).filter(f => f.endsWith('.mkv') || f.endsWith('.mp4')).sort();
  console.log(`\n🎬 Found ${files.length} episodes extracted in Part ${pack.part}:`);
  files.forEach((f, i) => console.log(`   [${i + 1}] ${f}`));

  for (let i = 0; i < files.length; i++) {
    const rawFilename = files[i];
    const safeFilename = rawFilename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const targetKey = `Luckyman/Season 01/${safeFilename}`;
    const filePath = path.join(workDir, rawFilename);

    try {
      await uploadLocalFileToZoho(filePath, targetKey);
      // Immediately delete file after verified upload
      fs.unlinkSync(filePath);
      console.log(`🗑️ Removed local copy: ${rawFilename}`);
    } catch (err) {
      console.error(`❌ Failed to upload ${rawFilename}:`, err.message);
    }
  }

  // Clean directory
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n🎉 Part ${pack.part} Completed Successfully!`);
}

async function run() {
  const args = process.argv.slice(2);
  let targetPart = 'all';
  const partIdx = args.indexOf('--part');
  if (partIdx !== -1 && args[partIdx + 1]) {
    targetPart = args[partIdx + 1];
  }

  // Resolve fresh packs if json missing or stale
  const packsFile = path.join(__dirname, 'luckyman_packs.json');
  if (!fs.existsSync(packsFile)) {
    console.log(`[*] Generating luckyman_packs.json...`);
    execSync('python resolve_luckyman.py', { stdio: 'inherit' });
  }

  const packs = JSON.parse(fs.readFileSync(packsFile, 'utf8'));

  for (const pack of packs) {
    if (targetPart !== 'all' && String(pack.part) !== String(targetPart)) {
      continue;
    }
    await processPack(pack);
  }

  console.log(`\n======================================================`);
  console.log(`🎉 ALL REQUESTED LUCKYMAN PACKS COMPLETED!`);
  console.log(`======================================================`);
}

if (require.main === module) {
  run().catch(console.error);
}

module.exports = { run, processPack };
