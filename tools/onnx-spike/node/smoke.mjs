// Node onnxruntime smoke test for the ONNX spike.
//
// Loads the exported Demucs core and the allin1 fold models with onnxruntime-node,
// runs them on the tensors dumped by the Python ORT runs (out/tensors/*.npy) and
// compares the outputs with the Python ORT outputs.
//
// Usage: node smoke.mjs [--ep cpu|coreml] [--coreml-flags N] [--only demucs,allin1,folds]
//        [--out results.json] [--log 0..4] [--ref-dir DIR] [--selftest]
// --ref-dir DIR: where allin1_mean_*.npy (Python ORT 8-fold mean) live; default out/tensors,
//   written by `uv run python make_ref_mean.py`. Without them the 8-fold check prints
//   "NOT CHECKED".
// --selftest: only verify that the comparison logic fails on NaN/Inf/mismatch, then exit.
// Exit code is 1 on any FAIL verdict or error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';

const here = path.dirname(fileURLToPath(import.meta.url));
const spike = path.resolve(here, '..');
const models = path.join(spike, 'out', 'models');
const tensors = path.join(spike, 'out', 'tensors');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const ep = opt('ep', 'cpu');
const only = new Set(opt('only', 'demucs,allin1,folds').split(','));
const outFile = opt('out', null);
const refDir = opt('ref-dir', tensors);
const selftest = args.includes('--selftest');
const logLevel = Number(opt('log', '3')); // 0 verbose .. 4 fatal

// CoreML flags (Node binding): 0x001 CPU only, 0x002 enable on subgraph, 0x004 ANE devices only,
// 0x008 static input shapes only, 0x010 MLProgram format, 0x020 CPU+GPU (no ANE).
const coreMlFlags = Number(opt('coreml-flags', '0'));
const providers = ep === 'cpu' ? ['cpu'] : [{ name: ep, coreMlFlags }, 'cpu'];
const sessionOptions = { executionProviders: providers, logSeverityLevel: logLevel };

// ---- minimal .npy reader (v1/v2/v3, little-endian f32 only) -------------------
function readNpy(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('latin1', 1, 6) !== 'NUMPY') throw new Error(`${file}: not npy`);
  const major = buf[6];
  const hlen = major === 1 ? buf.readUInt16LE(8) : buf.readUInt32LE(8);
  const start = (major === 1 ? 10 : 12) + hlen;
  const header = buf.toString('latin1', major === 1 ? 10 : 12, start);
  if (!header.includes("'<f4'")) throw new Error(`${file}: expected <f4, header ${header}`);
  if (header.includes("'fortran_order': True")) throw new Error(`${file}: fortran order`);
  const shape = header
    .match(/'shape': \(([^)]*)\)/)[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  const n = shape.reduce((a, b) => a * b, 1);
  const data = new Float32Array(n);
  new Uint8Array(data.buffer).set(buf.subarray(start, start + n * 4));
  return { shape, data };
}

// ---- metrics ----------------------------------------------------------------------
function compare(got, ref) {
  if (got.length !== ref.length) throw new Error(`length ${got.length} vs ${ref.length}`);
  let maxAbs = 0;
  let maxRef = 0;
  let nonFinite = 0; // NaN/Inf in either array: comparisons with NaN are false, so count explicitly
  let num = 0;
  let den = 0;
  for (let i = 0; i < ref.length; i++) {
    if (!Number.isFinite(got[i]) || !Number.isFinite(ref[i])) nonFinite++;
    const d = got[i] - ref[i];
    const ad = Math.abs(d);
    if (ad > maxAbs) maxAbs = ad;
    const ar = Math.abs(ref[i]);
    if (ar > maxRef) maxRef = ar;
    num += ref[i] * ref[i];
    den += d * d;
  }
  return {
    maxAbs,
    maxRef,
    nonFinite,
    rel: maxAbs / (maxRef || 1), // max abs diff relative to the reference peak
    sdrDb: den === 0 ? Infinity : 10 * Math.log10(num / den),
  };
}
const fmt = (c) =>
  `maxAbs=${c.maxAbs.toExponential(2)} rel=${c.rel.toExponential(2)} SDR=${
    Number.isFinite(c.sdrDb) ? c.sdrDb.toFixed(1) : 'inf'
  } dB`;

// ---- helpers ----------------------------------------------------------------------
const now = () => performance.now();
const secs = (ms) => +(ms / 1000).toFixed(3);

async function create(file) {
  const t = now();
  const session = await ort.InferenceSession.create(file, sessionOptions);
  return { session, createS: secs(now() - t) };
}
async function timedRun(session, feeds) {
  const t = now();
  const out = await session.run(feeds);
  return { out, runS: secs(now() - t) };
}

const results = { ep, coreMlFlags: ep === 'coreml' ? coreMlFlags : undefined, runs: {} };
const record = (key, value) => {
  results.runs[key] = value;
  console.log(`[${ep}] ${key}: ${JSON.stringify(value)}`);
};

// Pass bar from the controller: max abs < 1e-4 vs Python ORT; if that fails but
// SDR >= 60 dB it is a pass-with-note.
function verdict(cmp) {
  let v;
  if (cmp.nonFinite > 0 || !Number.isFinite(cmp.maxAbs)) v = 'FAIL (non-finite values)';
  else if (cmp.maxAbs < 1e-4) v = 'PASS';
  else if (cmp.sdrDb >= 60) v = 'PASS-with-note (abs>=1e-4, SDR>=60dB)';
  else v = 'FAIL';
  if (v.startsWith('FAIL')) process.exitCode = 1;
  return v;
}

if (selftest) {
  const ok = Float32Array.of(1, 2, 3, 4);
  const cases = [
    ['identical', ok, ok, 'PASS'],
    ['NaN in output', Float32Array.of(NaN, 2, 3, 4), ok, 'FAIL'],
    ['Inf in output', Float32Array.of(1, Infinity, 3, 4), ok, 'FAIL'],
    ['NaN in reference', ok, Float32Array.of(1, NaN, 3, 4), 'FAIL'],
    ['large mismatch', Float32Array.of(1, 2, 3, 5), ok, 'FAIL'],
    ['small diff', Float32Array.of(1, 2, 3, 4 + 5e-5), ok, 'PASS'],
  ];
  let bad = 0;
  for (const [name, got, ref, want] of cases) {
    const v = verdict(compare(got, ref));
    const good = v.startsWith(want);
    if (!good) bad++;
    console.log(`selftest ${good ? 'ok  ' : 'BAD '} ${name}: ${v}`);
  }
  process.exit(bad ? 1 : 0); // the FAIL cases set exitCode; selftest outcome decides instead
}

async function checkOutputs(label, out, refs) {
  const per = {};
  let worst = 'PASS';
  for (const [name, refFile] of Object.entries(refs)) {
    const ref = readNpy(refFile);
    const got = out[name];
    if (!got) throw new Error(`${label}: missing output ${name}`);
    const shapeOk = JSON.stringify(Array.from(got.dims)) === JSON.stringify(ref.shape);
    const c = compare(got.data, ref.data);
    const v = shapeOk ? verdict(c) : 'FAIL (shape)';
    if (!shapeOk) process.exitCode = 1;
    per[name] = { shape: Array.from(got.dims), shapeOk, ...c, verdict: v };
    console.log(`  ${label}.${name} ${JSON.stringify(per[name].shape)} ${fmt(c)} -> ${v}`);
    if (v === 'FAIL' || v.startsWith('FAIL')) worst = 'FAIL';
    else if (v !== 'PASS' && worst === 'PASS') worst = v;
  }
  return { per, verdict: worst };
}

// ---- Demucs core ------------------------------------------------------------------
async function demucs() {
  const mix = readNpy(path.join(tensors, 'demucs_mix.npy'));
  const spec = readNpy(path.join(tensors, 'demucs_spec.npy'));
  const feeds = {
    mix: new ort.Tensor('float32', mix.data, mix.shape),
    spec: new ort.Tensor('float32', spec.data, spec.shape),
  };
  const { session, createS } = await create(path.join(models, 'htdemucs_core.onnx'));
  console.log(`demucs inputs=${session.inputNames} outputs=${session.outputNames}`);
  const r1 = await timedRun(session, feeds);
  const r2 = await timedRun(session, feeds);
  const r3 = await timedRun(session, feeds);
  const check = await checkOutputs('demucs', r3.out, {
    spec_out: path.join(tensors, 'demucs_spec_out.npy'),
    wave_out: path.join(tensors, 'demucs_wave_out.npy'),
  });
  record('demucs', {
    createS,
    run1S: r1.runS,
    run2S: r2.runS,
    run3S: r3.runS,
    ...check,
  });
  await session.release();
}

// ---- allin1 fold 0 ----------------------------------------------------------------
const ALLIN1_OUT = ['logits_beat', 'logits_downbeat', 'logits_section', 'logits_function'];
const foldFile = (k) => path.join(models, `allin1_harmonix_fold${k}.onnx`);

async function allin1Fold0() {
  const spec = readNpy(path.join(tensors, 'allin1_spec.npy'));
  const feeds = { spec: new ort.Tensor('float32', spec.data, spec.shape) };
  const { session, createS } = await create(foldFile(0));
  const r1 = await timedRun(session, feeds);
  const r2 = await timedRun(session, feeds);
  const check = await checkOutputs(
    'allin1.fold0',
    r2.out,
    Object.fromEntries(ALLIN1_OUT.map((n) => [n, path.join(tensors, `allin1_${n}.npy`)])),
  );
  record('allin1_fold0', { createS, run1S: r1.runS, run2S: r2.runS, ...check });
  await session.release();
}

// ---- all 8 folds, averaged in JS (ruling S8) ----------------------------------------
async function allin1Folds() {
  const spec = readNpy(path.join(tensors, 'allin1_spec.npy'));
  const feeds = { spec: new ort.Tensor('float32', spec.data, spec.shape) };

  const tLoad = now();
  const sessions = [];
  const perCreate = [];
  for (let k = 0; k < 8; k++) {
    const c = await create(foldFile(k));
    sessions.push(c.session);
    perCreate.push(c.createS);
  }
  const loadAllS = secs(now() - tLoad);

  const runAll = async () => {
    const t = now();
    const sums = {};
    for (const s of sessions) {
      const out = await s.run(feeds);
      for (const n of ALLIN1_OUT) {
        const d = out[n].data;
        if (!sums[n]) sums[n] = { dims: Array.from(out[n].dims), data: new Float32Array(d.length) };
        const acc = sums[n].data;
        for (let i = 0; i < d.length; i++) acc[i] += d[i];
      }
    }
    for (const n of ALLIN1_OUT) {
      const acc = sums[n].data;
      for (let i = 0; i < acc.length; i++) acc[i] /= sessions.length;
    }
    return { mean: sums, runS: secs(now() - t) };
  };
  const a = await runAll();
  const b = await runAll();

  let check = null;
  const refFiles = ALLIN1_OUT.map((n) => path.join(refDir, `allin1_mean_${n}.npy`));
  if (!refFiles.every((f) => fs.existsSync(f))) {
    console.log(
      `  8-fold: NOT CHECKED (no allin1_mean_*.npy in ${refDir}; run: uv run python make_ref_mean.py)`,
    );
    check = { verdict: 'NOT CHECKED' };
  } else {
    const per = {};
    let worst = 'PASS';
    for (const n of ALLIN1_OUT) {
      const ref = readNpy(path.join(refDir, `allin1_mean_${n}.npy`));
      const c = compare(b.mean[n].data, ref.data);
      const v = verdict(c);
      per[n] = { shape: b.mean[n].dims, ...c, verdict: v };
      console.log(`  allin1.mean8.${n} ${JSON.stringify(b.mean[n].dims)} ${fmt(c)} -> ${v}`);
      if (v.startsWith('FAIL')) worst = 'FAIL';
      else if (v !== 'PASS' && worst === 'PASS') worst = v;
    }
    check = { per, verdict: worst };
  }
  record('allin1_8folds_mean', {
    loadAllS,
    perFoldCreateS: perCreate,
    runAll1S: a.runS,
    runAll2S: b.runS,
    check,
  });
  for (const s of sessions) await s.release();
}

console.log(`onnxruntime-node ep=${ep}`);
const t0 = now();
try {
  if (only.has('demucs')) await demucs();
  if (only.has('allin1')) await allin1Fold0();
  if (only.has('folds')) await allin1Folds();
} catch (e) {
  results.error = String(e?.stack ?? e);
  console.error(`[${ep}] ERROR: ${results.error}`);
  process.exitCode = 1;
}
results.totalS = secs(now() - t0);
// resourceUsage().maxRSS is the process peak, in KB (libuv normalises it on macOS too).
results.peakRssMB = Math.round((process.resourceUsage().maxRSS * 1024) / 1e6);
if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log(`done in ${results.totalS}s, peak RSS ${results.peakRssMB} MB`);
