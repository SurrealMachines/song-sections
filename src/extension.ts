import { initialize, type ActivationContext, type Handle } from "@ableton-extensions/sdk";
import dialogHtml from "../build/dialog.html";
import { defaultDeps, runFind } from "./flow.js";
import { registerDevStructure } from "./structure/devCommand.js";

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");
  const deps = defaultDeps(dialogHtml);

  context.commands.registerCommand("songSections.find", (handle) =>
    void runFind(context, handle as Handle, deps).catch((error) => console.error("Song Sections failed:", error)),
  );

  context.ui.registerContextMenuAction(
    "AudioClip",
    "Find Sections…",
    "songSections.find",
  );

  // Dev builds only (npm start): "Analyse Structure (dev)" runs the Structure engine alone and writes
  // <storageDirectory>/dev/*.json (Plan 3, Task 10). esbuild drops this branch in production builds.
  if (__DEV__) registerDevStructure(context);
}
