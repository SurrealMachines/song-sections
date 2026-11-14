// Dev "local directory override" (R3), offline: builds the model store in <storageDir>/models/<MODEL_SET>/ (the place
// the runtime reads) from the 9 source checkpoints in <srcDir>, exactly as the download does, without the network.
// <srcDir> holds the files under their Hugging Face names (src/structure/models.ts MODEL_SOURCES); a folder with both
// snapshot folders' files (or symlinks to them) works. Usage: npm run models:dev -- <srcDir> [storageDir = .dev/storage]
import { resolve } from "node:path";
import { installFromSources, modelsInstalled } from "../src/structure/models.js";

const [srcArg, storageArg = ".dev/storage"] = process.argv.slice(2);
if (!srcArg) {
  console.error("Usage: npm run models:dev -- <srcDir> [storageDir = .dev/storage]");
  process.exit(2);
}

const src = resolve(srcArg);
const storage = resolve(storageArg);
let lastPct = -1;
const dir = await installFromSources(storage, src, (done, total) => {
  const pct = Math.floor((100 * done) / total);
  if (pct !== lastPct && pct % 5 === 0) {
    lastPct = pct;
    process.stdout.write(`\rbuilding ${pct}% (${(done / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB)`);
  }
});
process.stdout.write("\n");
console.log(`Installed to ${dir}`);
console.log(`modelsInstalled: ${await modelsInstalled(storage)}`);
