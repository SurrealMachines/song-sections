// Dev only: writes build/dialog-preview.html (arrangement view, warp note on)
// and build/dialog-preview-session.html (plus -snap, -structure and -blocked variants) from canned 3-minute payloads.
// Run via `npm run dialog:preview`, which builds build/dialog.html first.
// There is no audio.wav next to these files, so playback shows its inline error.
import * as fs from "node:fs";
import { cannedHarmony, cannedPayload, cannedStructurePayload } from "../src/dialog/fixture.js";
import { injectPayload } from "../src/dialog/protocol.js";

const html = fs.readFileSync("build/dialog.html", "utf8");
const outputs = {
  "build/dialog-preview.html": cannedPayload({ warpNote: true, harmony: cannedHarmony(), setScale: { root: 2, name: "Minor" } }),
  "build/dialog-preview-session.html": cannedPayload({ view: "session", clipName: "Preview Track (Session)" }),
  "build/dialog-preview-snap.html": cannedPayload({ beatGrid: Array.from({ length: 360 }, (_, i) => i * 0.5), snap: true }),
  "build/dialog-preview-structure.html": cannedStructurePayload({ harmony: cannedHarmony("stems") }),
  "build/dialog-preview-blocked.html": cannedPayload({
    modes: { structure: { available: false, reason: "Structure analysis needs the models (190 MB).", cached: false, needsDownload: true, downloadBytes: 190048947, estimateSec: 66, warn: false } },
  }),
};
for (const [path, payload] of Object.entries(outputs)) {
  fs.writeFileSync(path, injectPayload(html, payload));
  console.log("wrote", path);
}
