import { mount } from "svelte";
import App from "./App.svelte";
import { signalReady } from "./bridge.js";
import { readPayload } from "./protocol.js";

const target = document.getElementById("app")!;
try {
  // App picks CueView or StructureView by payload.mode.
  mount(App, { target, props: { payload: readPayload(document) } });
  signalReady();
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  target.textContent = "Song Sections could not open: " + message;
  signalReady(message);
}
