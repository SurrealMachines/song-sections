<script lang="ts">
  import type { Section } from "../core/types.js";
  import { liveColor, onSchemeChange } from "./liveTheme.js";
  import { bypassesSnap } from "./modifier.js";
  import type { Pcm16 } from "./player.js";
  import { createSamplePeaks, type SamplePeaks } from "./samplePeaks.js";
  import { columnBlocks } from "./stemPeaks.js";
  import { fitView, type ZoomView } from "./zoom.js";

  interface Props {
    waveform: { min: number[]; max: number[] };
    duration: number;
    sections: Section[];
    playhead: number | null;
    /** fb3: the zoomed window of clip seconds on screen (the whole clip by default). */
    view?: ZoomView;
    /** fb4, item 2: the preview's samples once the player has them (null before): a zoomed view draws from them. */
    pcm?: Pcm16 | null;
    /** Double-click on empty waveform, with the time under the pointer and whether the snap-bypass key was held. */
    onadd: (t: number, free: boolean) => void;
    /** Single click on empty waveform. */
    onbackground: () => void;
  }

  // svelte-ignore state_referenced_locally
  let { waveform, duration, sections, playhead, view = fitView(duration), pcm = null, onadd, onbackground }: Props = $props();
  const px = (t: number) => ((t - view.start) / view.span) * width;

  let canvas: HTMLCanvasElement;
  // The canvases are painted in Live's theme colours, so they repaint when the system switches light or dark.
  let schemeChanges = $state(0);
  $effect(() => onSchemeChange(() => schemeChanges++));
  let width = $state(0);
  let height = $state(0);

  const hex = (rgb: number) => "#" + rgb.toString(16).padStart(6, "0");

  // fb4, item 2: the samples' min/max mipmap (samplePeaks.ts), built in slices once the preview is in, so neither the
  // build nor a draw holds a frame up. `built` bumps when it completes, to redraw from it.
  /** Frames of the mipmap's base level built per slice: ~4 ms at 24 kHz mono. */
  const BUILD_SLICE = 1 << 21;
  let peaks: SamplePeaks | null = null;
  let built = $state(0);
  $effect(() => {
    const p = pcm;
    if (!p) return;
    const pk = createSamplePeaks(p);
    peaks = pk;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = () => {
      if (pk.build(BUILD_SLICE)) built++;
      else timer = setTimeout(step, 0);
    };
    timer = setTimeout(step, 0);
    return () => {
      clearTimeout(timer);
      if (peaks === pk) peaks = null;
    };
  });
  let lo = new Float32Array(0);
  let hi = new Float32Array(0);

  $effect(() => {
    const ro = new ResizeObserver(([entry]) => {
      width = entry.contentRect.width;
      height = entry.contentRect.height;
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  });

  $effect(() => {
    const dpr = window.devicePixelRatio || 1;
    if (!width || !height) return;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const g = canvas.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);

    // Section tints behind the waveform: only the ones on screen (fb3: zoom).
    for (const s of sections) {
      if (s.end < view.start || s.start > view.start + view.span) continue;
      g.fillStyle = hex(s.color) + "99";
      g.fillRect(px(s.start), 0, px(s.end) - px(s.start), height);
    }

    // For the tests: what this frame was drawn from, written only when it changes (fb4 review M4).
    const mark = (from: string) => {
      if (canvas.dataset.drawn !== from) canvas.dataset.drawn = from;
    };

    // One column per device pixel, so a zoomed waveform is as sharp as the screen.
    const columns = Math.max(1, Math.round(width * dpr));
    const colW = width / columns;
    const mid = height / 2;
    const amp = height / 2 - 4;
    void schemeChanges;
    g.fillStyle = liveColor(canvas, "--live-waveform");
    const bar = (x: number, mn: number, mx: number) => {
      const top = mid - mx * amp;
      g.fillRect(x * colW, top, colW, Math.max(1, mid - mn * amp - top));
    };

    // fb3: zoomed, only the min/max bins under the view are read, so a 30-minute clip draws as fast at 8x as at fit.
    const { min, max } = waveform;
    const n = Math.min(min.length, max.length);
    const from = n ? (view.start / duration) * n : 0;
    const to = n ? ((view.start + view.span) / duration) * n : 0;

    // fb4, item 2: once the overview has fewer bins on screen than there are columns, the samples draw it instead
    // (straight from them when deep, from the mipmap otherwise), when they are in; until then, the overview.
    void built; // redraw when the samples arrive and once the mipmap is complete
    void pcm;
    // A preview shorter than the clip (a test's stand-in) is not the clip's audio: the overview draws it then.
    const pk = peaks && peaks.frames >= (duration - 0.1) * peaks.rate ? peaks : null;
    if (pk && (to - from < columns || !n)) {
      if (lo.length < columns) {
        lo = new Float32Array(columns);
        hi = new Float32Array(columns);
      }
      const f0 = view.start * pk.rate;
      const f1 = (view.start + view.span) * pk.rate;
      if (pk.columns(f0, f1, columns, lo, hi)) {
        for (let x = 0; x < columns; x++) bar(x, lo[x], hi[x]);
        mark("samples");
        return;
      }
    }
    mark("overview");
    if (!n) return;
    for (let x = 0; x < columns; x++) {
      const [a, b] = columnBlocks(x, columns, n, from, to);
      let l = 0;
      let h = 0;
      for (let i = a; i < b; i++) {
        if (min[i] < l) l = min[i];
        if (max[i] > h) h = max[i];
      }
      bar(x, l, h);
    }
  });

  function timeAt(e: MouseEvent): number {
    const r = canvas.getBoundingClientRect();
    return Math.min(duration, Math.max(0, view.start + ((e.clientX - r.left) / r.width) * view.span));
  }
</script>

<div class="waveform">
  <canvas bind:this={canvas} ondblclick={(e) => onadd(timeAt(e), bypassesSnap(e))} onclick={onbackground}></canvas>
  {#if playhead !== null && playhead >= view.start && playhead <= view.start + view.span}
    <div class="playhead" style:left="{((playhead - view.start) / view.span) * 100}%"></div>
  {/if}
</div>

<style>
  .waveform {
    position: relative;
    flex: 1 1 0; /* the Timeline gives it the spare height */
    min-height: 120px;
    background: var(--live-detail);
  }
  canvas {
    position: absolute; /* sized by the box, never by its own pixel buffer */
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
  }
  .playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--live-fg);
    pointer-events: none;
  }
</style>
