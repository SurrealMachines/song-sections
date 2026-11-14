/**
 * Which files of the onnxruntime-node package ship in `native/` (used by build.ts and tests).
 * CPU execution only (verdict criterion 6), so every other execution provider is left out on every
 * platform: DirectML and its shader compiler (Microsoft redistributables with their own licence, and
 * `onnxruntime.dll` only delay-loads DirectML.dll), plus any `onnxruntime_providers_*` library
 * (CUDA, TensorRT, OpenVINO, ...). `libonnxruntime.<x.y.z>.dylib` is a byte-identical duplicate of
 * `libonnxruntime.<x>.dylib`.
 */
const EXCLUDED: RegExp[] = [
  /(^|[\\/])(DirectML|dxcompiler|dxil)\.dll$/i,
  /(^|[\\/])(lib)?onnxruntime_providers_[^\\/]*$/i,
  /libonnxruntime\.\d+\.\d+\.\d+\.dylib$/,
];

export function isShippedNativeFile(path: string): boolean {
  return !EXCLUDED.some((re) => re.test(path));
}
