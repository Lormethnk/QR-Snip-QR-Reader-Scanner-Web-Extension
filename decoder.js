// QR decoding for the service worker, built on zxing-cpp (lib/zxing-reader.js,
// loaded by background.js). It runs here rather than in the page because
// WebAssembly in a content script is subject to the page's CSP.
// Exposes decodeQrImage(dataUrl) -> Promise<string | null>.

const MAX_SCALED_SIDE = 2400;
// Upscaling rescues codes that are only 2-3 px per module (PDF viewer, dense
// codes); zxing-cpp downscales large inputs by itself.
const UPSCALE_STEPS = [2, 3, 4];
const SHARPEN_AMOUNT = 2;
// A code that is found but fails error correction is retried on its own,
// enlarged: far cheaper than enlarging the whole selection.
const REFINE_STEPS = [2, 3, 4, 6];
const REFINE_PADDING = 0.25;
const MAX_CANDIDATES = 4;
// Large selections can't be upscaled whole, so as a last resort they are
// scanned in overlapping tiles. A code up to TILE_SIZE / 2 wide always fits
// inside one tile; bigger ones are already readable without upscaling.
const TILE_SIZE = 600;
const TILE_SCALE = 3;
// Upper bound on one decode, so a hopeless selection still answers promptly.
const TIME_BUDGET_MS = 3000;

const READER_OPTIONS = {
  formats: ['QRCode', 'MicroQRCode', 'rMQRCode'],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  tryDenoise: true,
  // Undecodable symbols are reported too; their positions seed the refine pass.
  returnErrors: true,
  maxNumberOfSymbols: 4,
};

// The library defaults to fetching the .wasm from a CDN; always use the
// bundled copy so nothing is loaded from the network.
ZXingWASM.setZXingModuleOverrides({
  locateFile: (path, prefix) =>
    path.endsWith('.wasm') ? chrome.runtime.getURL('lib/zxing_reader.wasm') : prefix + path,
});

async function decodeQrImage(dataUrl) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const scales = [1, ...UPSCALE_STEPS.filter((s) => longest * s <= MAX_SCALED_SIDE)];

    const full = { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
    const candidates = [];
    const deadline = performance.now() + TIME_BUDGET_MS;
    const expired = () => performance.now() > deadline;

    // Cheap passes first: plain rescales, then unsharp-masked ones, which
    // recover blurry or low-contrast photos of printed codes.
    for (const sharpen of [false, true]) {
      for (const scale of scales) {
        if (expired()) break;
        const text = await read(bitmap, full, scale, sharpen, candidates);
        if (text !== null) return text;
      }
    }

    for (const region of candidates.slice(0, MAX_CANDIDATES)) {
      const side = Math.max(region.w, region.h);
      for (const sharpen of [false, true]) {
        for (const scale of REFINE_STEPS.filter((s) => side * s <= MAX_SCALED_SIDE)) {
          if (expired()) return null;
          const text = await read(bitmap, region, scale, sharpen);
          if (text !== null) return text;
        }
      }
    }

    if (longest > TILE_SIZE) {
      for (const sharpen of [false, true]) {
        for (const tile of tiles(bitmap.width, bitmap.height)) {
          if (expired()) return null;
          const text = await read(bitmap, tile, TILE_SCALE, sharpen);
          if (text !== null) return text;
        }
      }
    }
    return null;
  } finally {
    bitmap.close();
  }
}

// Decodes one region of the bitmap at the given scale. Symbols that were
// located but not decoded are appended to `candidates` (in bitmap pixels).
async function read(bitmap, region, scale, sharpen, candidates) {
  let image = renderScaled(bitmap, scale, region);
  if (sharpen) image = unsharpMask(image, Math.max(2, scale), SHARPEN_AMOUNT);
  const results = await ZXingWASM.readBarcodes(image, READER_OPTIONS);
  const valid = results.find((result) => result.isValid);
  if (valid) return valid.text;

  for (const { position } of candidates ? results : []) {
    const corners = [position.topLeft, position.topRight, position.bottomRight, position.bottomLeft];
    const xs = corners.map((c) => region.x + c.x / scale);
    const ys = corners.map((c) => region.y + c.y / scale);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    const pad = Math.max(8, Math.max(w, h) * REFINE_PADDING);
    const x = Math.max(0, Math.floor(Math.min(...xs) - pad));
    const y = Math.max(0, Math.floor(Math.min(...ys) - pad));
    const candidate = {
      x,
      y,
      w: Math.min(bitmap.width - x, Math.ceil(w + pad * 2)),
      h: Math.min(bitmap.height - y, Math.ceil(h + pad * 2)),
    };
    const isNew = candidates.every((c) => Math.abs(c.x - x) + Math.abs(c.y - y) + Math.abs(c.w - candidate.w) > 12);
    if (isNew && candidate.w >= 16 && candidate.h >= 16) candidates.push(candidate);
  }
  return null;
}

// Half-overlapping TILE_SIZE squares covering a width x height area.
function* tiles(width, height) {
  const starts = (length) => {
    if (length <= TILE_SIZE) return [0];
    const count = Math.ceil((length - TILE_SIZE) / (TILE_SIZE / 2)) + 1;
    return Array.from({ length: count }, (_, i) => Math.round((i * (length - TILE_SIZE)) / (count - 1)));
  };
  for (const y of starts(height)) {
    for (const x of starts(width)) {
      yield { x, y, w: Math.min(TILE_SIZE, width), h: Math.min(TILE_SIZE, height) };
    }
  }
}

function renderScaled(bitmap, scale, region) {
  const width = Math.max(1, Math.round(region.w * scale));
  const height = Math.max(1, Math.round(region.h * scale));
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  // Smooth scaling matters: nearest-neighbour keeps anti-aliased gray module
  // edges as blocks, which binarizers misread.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, region.x, region.y, region.w, region.h, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

// Grayscale unsharp mask: out = v + amount * (v - boxBlur(v, radius)).
function unsharpMask(image, radius, amount) {
  const { width, height, data } = image;
  const size = width * height;
  const gray = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  const blurred = boxBlur(boxBlur(gray, width, height, radius, true), width, height, radius, false);

  const out = new ImageData(width, height);
  for (let i = 0; i < size; i++) {
    const v = gray[i] + amount * (gray[i] - blurred[i]);
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v; // clamped by the array
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

// One separable box-blur pass (sliding window, edges use the available samples).
function boxBlur(src, width, height, radius, horizontal) {
  const dst = new Float32Array(src.length);
  const lines = horizontal ? height : width;
  const length = horizontal ? width : height;
  const step = horizontal ? 1 : width;
  for (let line = 0; line < lines; line++) {
    const start = horizontal ? line * width : line;
    let sum = 0;
    let count = 0;
    for (let k = 0; k <= radius && k < length; k++) {
      sum += src[start + k * step];
      count++;
    }
    for (let i = 0; i < length; i++) {
      dst[start + i * step] = sum / count;
      const add = i + radius + 1;
      const drop = i - radius;
      if (add < length) {
        sum += src[start + add * step];
        count++;
      }
      if (drop >= 0) {
        sum -= src[start + drop * step];
        count--;
      }
    }
  }
  return dst;
}
