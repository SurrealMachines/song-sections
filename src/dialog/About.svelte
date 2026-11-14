<script lang="ts">
  // The header's About button and its panel: version, who made it, and the feedback, page and source links. A link is
  // opened by the extension in the system browser (GET open?to=<key>, dialogServer.ts), never in this dialog; when that
  // fails the panel says to copy the link, which is always shown and selectable.
  import { ABOUT_LINKS, OPEN_LINK_ROUTE, VERSION, type AboutLink } from "../core/about.js";

  let open = $state(false);
  let failed = $state<AboutLink | null>(null);

  const rows: { key: AboutLink; label: string }[] = [
    { key: "feedback", label: "Send feedback" },
    { key: "page", label: "Song Sections page" },
    { key: "source", label: "Source code" },
  ];

  async function follow(key: AboutLink): Promise<void> {
    failed = null;
    try {
      const r = await fetch(`${OPEN_LINK_ROUTE}?to=${key}`, { cache: "no-store" });
      if (!r.ok) failed = key;
    } catch {
      failed = key;
    }
  }

  function onkeydown(e: KeyboardEvent): void {
    if (open && e.key === "Escape") {
      e.stopPropagation();
      open = false;
    }
  }
</script>

<svelte:window onkeydowncapture={onkeydown} />

<button type="button" class="about-button" tabindex="-1" aria-expanded={open} onclick={() => (open = !open)}>About</button>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={() => (open = false)}></div>
  <div class="about" role="dialog" aria-label="About Song Sections">
    <div class="name">Song Sections <span class="version">{VERSION}</span></div>
    <p>By Matt Jackson · Surreal Machines</p>
    <p class="muted">Free and open source (MIT). An independent project: not made or supported by Ableton.</p>
    <ul>
      {#each rows as row (row.key)}
        <li>
          <button type="button" class="link" tabindex="-1" onclick={() => void follow(row.key)}>{row.label}</button>
          <span class="url">{ABOUT_LINKS[row.key]}</span>
          {#if failed === row.key}<span class="failed">Couldn't open your browser. Copy the link above.</span>{/if}
        </li>
      {/each}
    </ul>
    <p class="muted small">Built on allin1 (Taejun Kim), HT Demucs (Meta), madmom, Meyda, fft.js and ONNX Runtime.</p>
    <button type="button" class="close" tabindex="-1" onclick={() => (open = false)}>Close</button>
  </div>
{/if}

<style>
  .about-button {
    flex: none;
    align-self: flex-start;
    padding: 2px 6px;
    background: none;
    border: 1px solid var(--live-frame);
    border-radius: 2px;
    color: var(--muted-text-color);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .about-button:hover,
  .about-button[aria-expanded="true"] {
    color: var(--live-fg);
  }
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 49;
  }
  .about {
    position: fixed;
    z-index: 50;
    top: 44px;
    right: 16px;
    box-sizing: border-box;
    width: 340px;
    padding: 12px 14px;
    background: var(--live-surface);
    border: 1px solid var(--live-frame);
    border-radius: 2px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.32);
    color: var(--live-fg);
    font-family: var(--control-font);
    font-size: 12px;
    line-height: 1.4;
  }
  .name {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .version {
    color: var(--muted-text-color);
    font-weight: 400;
  }
  p {
    margin: 0 0 6px;
  }
  .muted {
    color: var(--muted-text-color);
  }
  .small {
    font-size: 11px;
  }
  ul {
    list-style: none;
    margin: 8px 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  li {
    display: grid;
  }
  .link {
    justify-self: start;
    padding: 0;
    background: none;
    border: none;
    color: var(--live-on);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  .url {
    color: var(--muted-text-color);
    font-size: 10.5px;
    user-select: text;
    -webkit-user-select: text;
    overflow-wrap: anywhere;
  }
  .failed {
    color: var(--live-fg);
    font-size: 11px;
  }
  .close {
    margin-top: 4px;
    padding: 2px 10px;
    background: var(--live-control);
    border: 1px solid var(--live-frame);
    border-radius: 2px;
    color: var(--live-fg);
    font: inherit;
    cursor: pointer;
  }
</style>
