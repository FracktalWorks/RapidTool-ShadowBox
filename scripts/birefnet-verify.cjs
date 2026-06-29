/**
 * Offline BiRefNet verification — does it capture chrome the IS-Net mask dropped?
 * Runs the 224MB fp32 model in Node (no browser tab memory cap) on a dumped crop.
 * Usage: node scripts/birefnet-verify.cjs [test-photos/sod-samples/hammer_crop.png]
 */
const ort = require('onnxruntime-node');
const sharp = require('sharp');
const { PNG } = require('pngjs');
const fs = require('fs');
const { join, basename } = require('path');

const SIZE = Number(process.env.SIZE) || 1024;
const cropPath = process.argv[2] || 'test-photos/sod-samples/hammer_crop.png';
const OUT = 'test-photos/output';

(async () => {
  console.log('loading BiRefNet (224MB)…');
  const t0 = Date.now();
  const session = await ort.InferenceSession.create('public/models/birefnet_lite.onnx');
  console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s · inputs=${session.inputNames} outputs=${session.outputNames}`);

  const { data } = await sharp(cropPath).resize(SIZE, SIZE, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const plane = SIZE * SIZE;
  const input = new Float32Array(3 * plane);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let i = 0; i < plane; i++) {
    input[i] = (data[i * 3] / 255 - mean[0]) / std[0];
    input[plane + i] = (data[i * 3 + 1] / 255 - mean[1]) / std[1];
    input[2 * plane + i] = (data[i * 3 + 2] / 255 - mean[2]) / std[2];
  }
  const feeds = {}; feeds[session.inputNames[0]] = new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]);
  const t1 = Date.now();
  const out = await session.run(feeds);
  const o = out[session.outputNames[0]];
  console.log(`inference ${((Date.now() - t1) / 1000).toFixed(1)}s · out dims=${o.dims} len=${o.data.length}`);

  const sal = o.data;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < plane; i++) { const v = sal[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  const range = mx - mn || 1;
  let white = 0;
  const png = new PNG({ width: SIZE, height: SIZE });
  for (let i = 0; i < plane; i++) {
    const v = ((sal[i] - mn) / range) * 255;
    if (v > 127) white++;
    png.data[i * 4] = v; png.data[i * 4 + 1] = v; png.data[i * 4 + 2] = v; png.data[i * 4 + 3] = 255;
  }
  const name = basename(cropPath).replace('_crop.png', '').replace('.png', '');
  fs.writeFileSync(join(OUT, `${name}_birefnet_mask.png`), PNG.sync.write(png));
  // column-fill across width (compare to IS-Net: head ~34% · SHAFT 6-9% · handle 11-16%)
  const col = new Array(SIZE).fill(0);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (((sal[y * SIZE + x] - mn) / range) * 255 > 127) col[x]++;
  let s = 'col-fill%: ';
  for (let i = 0; i <= 10; i++) { const x = Math.min(SIZE - 1, Math.round(i * 0.1 * SIZE)); s += i * 10 + '%:' + ((100 * col[x] / SIZE) | 0) + ' '; }
  console.log(`white=${(100 * white / plane).toFixed(1)}% of mask · ${s}`);
  console.log(`saved ${name}_birefnet_mask.png`);
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
