const rmMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("node:fs/promises", () => ({ rm: rmMock }));

import { ClipSlot } from "@ableton-extensions/sdk";
import { describe, expect, it, vi } from "vitest";
import { acquireAudio, describeClip, type ClipInfo } from "./acquire.js";

function makeFakes(opts: { renderError?: Error; abortAfterCreate?: AbortController; abortDuringRender?: AbortController } = {}) {
  const tempTrack = {
    createAudioClip: vi.fn(async () => {
      opts.abortAfterCreate?.abort();
      return {};
    }),
  };
  const song = {
    tempo: 120,
    createAudioTrack: vi.fn(async () => tempTrack),
    deleteTrack: vi.fn(async () => undefined),
  };
  const renderPreFxAudio = vi.fn(async () => {
    if (opts.renderError) throw opts.renderError;
    opts.abortDuringRender?.abort();
    return "/tmp/render.aif";
  });
  const context = { application: { song }, resources: { renderPreFxAudio } };
  return { context, song, tempTrack, renderPreFxAudio };
}

const sessionInfo = (over: Partial<ClipInfo> = {}): ClipInfo =>
  ({
    view: "session",
    clip: {},
    track: {},
    startTime: 0,
    lengthBeats: 16,
    startMarker: 4,
    endMarker: 20,
    warped: true,
    filePath: "/samples/a.wav",
    color: 0,
    name: "x",
    ...over,
  }) as unknown as ClipInfo;

describe("acquireAudio", () => {
  it("arrangement renders the clip's range on its own track", async () => {
    const f = makeFakes();
    const track = {};
    const info = sessionInfo({ view: "arrangement", track: track as never, startTime: 8, lengthBeats: 32 });
    const path = await acquireAudio(f.context as never, info, new AbortController().signal);
    expect(path).toBe("/tmp/render.aif");
    expect(f.renderPreFxAudio).toHaveBeenCalledWith(track, 8, 40);
    expect(f.song.createAudioTrack).not.toHaveBeenCalled();
  });

  it("session creates explicit loop settings, renders 0..length, deletes the temp track once", async () => {
    const f = makeFakes();
    const path = await acquireAudio(f.context as never, sessionInfo(), new AbortController().signal);
    expect(path).toBe("/tmp/render.aif");
    expect(f.tempTrack.createAudioClip).toHaveBeenCalledWith({
      filePath: "/samples/a.wav",
      startTime: 0,
      isWarped: true,
      loopSettings: { startMarker: 4, endMarker: 20, loopStart: 4, loopEnd: 20, looping: false },
    });
    // Length comes from the markers: a duration that differs from the marker span makes Live reject the create.
    expect((f.tempTrack.createAudioClip.mock.calls[0] as unknown[])[0]).not.toHaveProperty("duration");
    expect(f.renderPreFxAudio).toHaveBeenCalledWith(f.tempTrack, 0, 16);
    expect(f.song.deleteTrack).toHaveBeenCalledTimes(1);
    expect(f.song.deleteTrack).toHaveBeenCalledWith(f.tempTrack);
  });

  // fb3, item 1 (Matt): a Session clip warped at 150 BPM with the song at 150 previewed fast, and its slices came out
  // warped at 120. A clip created from the file gets Live's own warp grid, not the source's markers.
  const at150 = [
    { beatTime: 0, sampleTime: 0 },
    { beatTime: 1, sampleTime: 0.4 },
  ];
  for (const tempo of [150, 120]) {
    it(`a warped session clip with warp markers renders unwarped from their file seconds (song at ${tempo})`, async () => {
      const f = makeFakes();
      f.song.tempo = tempo;
      await acquireAudio(f.context as never, sessionInfo({ warpMarkers: at150 }), new AbortController().signal);
      const args = (f.tempTrack.createAudioClip.mock.calls[0] as unknown[])[0] as { isWarped: boolean; loopSettings: Record<string, number | boolean> };
      expect(args.isWarped).toBe(false);
      // Beats 4..20 at 150 BPM are 1.6..8 s of the file, whatever the song tempo.
      expect(args.loopSettings.startMarker).toBeCloseTo(1.6, 12);
      expect(args.loopSettings.endMarker).toBeCloseTo(8, 12);
      expect(args.loopSettings).toMatchObject({ looping: false });
      expect(args.loopSettings.loopStart).toBe(args.loopSettings.startMarker);
      expect(args.loopSettings.loopEnd).toBe(args.loopSettings.endMarker);
      // 6.4 s of file at the song tempo: the render is the file at its own rate.
      expect((f.renderPreFxAudio.mock.calls[0] as unknown[])[2]).toBeCloseTo((6.4 * tempo) / 60, 12);
    });
  }

  it("an unwarped session clip still renders as it is", async () => {
    const f = makeFakes();
    await acquireAudio(f.context as never, sessionInfo({ warped: false, startMarker: 1, endMarker: 9, lengthBeats: 16 }), new AbortController().signal);
    expect(f.tempTrack.createAudioClip).toHaveBeenCalledWith(expect.objectContaining({ isWarped: false, loopSettings: expect.objectContaining({ startMarker: 1, endMarker: 9 }) }));
    expect(f.renderPreFxAudio).toHaveBeenCalledWith(f.tempTrack, 0, 16);
  });

  it("deletes the temp track once when renderPreFxAudio throws", async () => {
    const f = makeFakes({ renderError: new Error("boom") });
    await expect(acquireAudio(f.context as never, sessionInfo(), new AbortController().signal)).rejects.toThrow("boom");
    expect(f.song.deleteTrack).toHaveBeenCalledTimes(1);
  });

  it("deletes the temp track once when aborted after the track was created", async () => {
    const ac = new AbortController();
    const f = makeFakes({ abortAfterCreate: ac });
    await expect(acquireAudio(f.context as never, sessionInfo(), ac.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.song.deleteTrack).toHaveBeenCalledTimes(1);
    expect(f.renderPreFxAudio).not.toHaveBeenCalled();
  });

  it("deletes the rendered file when aborted after the render resolved", async () => {
    const ac = new AbortController();
    const f = makeFakes({ abortDuringRender: ac });
    rmMock.mockClear();
    await expect(acquireAudio(f.context as never, sessionInfo(), ac.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(rmMock).toHaveBeenCalledWith("/tmp/render.aif", { force: true });
    expect(f.song.deleteTrack).toHaveBeenCalledTimes(1);
  });

  it("throws AbortError before doing anything when already aborted", async () => {
    const f = makeFakes();
    const ac = new AbortController();
    ac.abort();
    await expect(acquireAudio(f.context as never, sessionInfo(), ac.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.song.createAudioTrack).not.toHaveBeenCalled();
    expect(f.song.deleteTrack).not.toHaveBeenCalled();
  });
});

describe("describeClip", () => {
  const clipProps = {
    name: "Song",
    color: 0xff8000n,
    startTime: 16,
    endTime: 48,
    startMarker: 2,
    endMarker: 18,
    filePath: "/a.wav",
    warpMarkers: [
      { beatTime: 0, sampleTime: 0 },
      { beatTime: 1, sampleTime: 0.4 },
    ],
  };

  it("copies a warped clip's warp markers up front (the source is not read again on Apply)", () => {
    const ctx = { application: { song: { tempo: 150 } } } as never;
    const warped = describeClip(ctx, { ...clipProps, parent: { clipSlots: [] }, warping: true } as never);
    expect(warped.warpMarkers).toEqual(clipProps.warpMarkers);
    expect(warped.warpMarkers).not.toBe(clipProps.warpMarkers);
    const unwarped = describeClip(ctx, { ...clipProps, parent: { clipSlots: [] }, warping: false } as never);
    expect(unwarped.warpMarkers).toBeUndefined();
  });

  it("describes an arrangement clip (parent is the track)", () => {
    const track = { clipSlots: [] };
    const clip = { ...clipProps, parent: track, warping: true };
    const info = describeClip({ application: { song: { tempo: 120 } } } as never, clip as never);
    expect(info).toMatchObject({ view: "arrangement", track, startTime: 16, lengthBeats: 32, startMarker: 2, endMarker: 18, warped: true, color: 0xff8000, name: "Song", filePath: "/a.wav" });
    expect(info.sceneIndex).toBeUndefined();
  });

  it("records the warp mode up front for warped clips only", () => {
    const ctx = { application: { song: { tempo: 120 } } } as never;
    const warped = describeClip(ctx, { ...clipProps, parent: { clipSlots: [] }, warping: true, warpMode: 4 } as never);
    expect(warped.warpMode).toBe(4);
    const unwarped = describeClip(ctx, { ...clipProps, parent: { clipSlots: [] }, warping: false, warpMode: 4 } as never);
    expect(unwarped.warpMode).toBeUndefined();
  });

  it("describes a session clip: warped length from markers, scene index from slot", () => {
    const slot = Object.create(ClipSlot.prototype);
    const other = {};
    const track = { clipSlots: [other, slot] };
    Object.defineProperty(slot, "parent", { value: track });
    const clip = { ...clipProps, parent: slot, warping: true };
    const info = describeClip({ application: { song: { tempo: 120 } } } as never, clip as never);
    expect(info).toMatchObject({ view: "session", track, sceneIndex: 1, lengthBeats: 16 });
  });

  it("unwarped session clip converts marker seconds to beats at the song tempo", () => {
    const slot = Object.create(ClipSlot.prototype);
    const track = { clipSlots: [slot] };
    Object.defineProperty(slot, "parent", { value: track });
    const clip = { ...clipProps, parent: slot, warping: false, startMarker: 1, endMarker: 11 };
    const info = describeClip({ application: { song: { tempo: 120 } } } as never, clip as never);
    expect(info.lengthBeats).toBe(20);
    expect(info.warped).toBe(false);
  });
});
