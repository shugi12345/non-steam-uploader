// Downloads the official rclone binaries into vendor/rclone/<platform>/ so they ship inside the app.
// Runs on `npm install` (postinstall) and before builds; skips platforms already fetched.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const TARGETS = [
  { dir: "win32", zip: "rclone-current-windows-amd64.zip", bin: "rclone.exe" },
  { dir: "linux", zip: "rclone-current-linux-amd64.zip", bin: "rclone" }
];
const VENDOR = path.join(__dirname, "..", "vendor", "rclone");

// Extract one file from a zip buffer (stdlib only: central directory + raw inflate).
function extractFromZip(buf, wantedName) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  if (eocd < 0) throw new Error("Not a zip file.");
  let ptr = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    if (path.posix.basename(name) === wantedName) {
      const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
      const data = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`Unsupported zip compression method ${method}.`);
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${wantedName} not found in zip.`);
}

async function main() {
  for (const target of TARGETS) {
    const out = path.join(VENDOR, target.dir, target.bin);
    if (fs.existsSync(out)) continue;

    const url = `https://downloads.rclone.org/${target.zip}`;
    console.log(`Fetching ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
    const bin = extractFromZip(Buffer.from(await res.arrayBuffer()), target.bin);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, bin, { mode: 0o755 });
    console.log(`  -> ${path.relative(process.cwd(), out)} (${(bin.length / 1e6).toFixed(1)} MB)`);
  }
}

main().catch((error) => {
  console.error(`fetch-rclone: ${error.message}`);
  process.exit(1);
});
