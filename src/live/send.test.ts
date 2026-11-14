// v2 sends against a fake Live API (as execute.test.ts does): real slices from a real WAV, a fake project folder for
// importIntoProject, and fake tracks, devices, chains and clips that log every call and whether it ran in a transaction.
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readPcmFile } from "../audio/pcmFile.js";
import type { Section } from "../core/types.js";
import { makeWav } from "../test/makeWav.js";
import type { Harmony } from "../dialog/protocol.js";
import { clipKey, estimateKey, KK_MAJOR, KK_MINOR, keyShort, sectionKeys, withHarmonics } from "../key/key.js";
import type { ClipInfo } from "./acquire.js";
import {
  executeSend,
  MAX_PADS,
  padNotes,
  safeFileName,
  sectionBeats,
  SendError,
  sendFailedMessage,
  uniqueFileNames,
  withHash,
  nameKeys,
  padPlan,
  sceneStarts,
  type SendRequest,
} from "./send.js";
import { STEM_NAMES, type StemName } from "../structure/contract.js";

const RATE = 1000; // frames per second: a section's frame count reads as its milliseconds
const SECONDS = 20;
const SECTIONS: Section[] = [
  { start: 0, end: 5, label: "A - intro", color: 0xff0000 },
  { start: 5, end: 12.25, label: "B", color: 0x00ff00 },
  { start: 12.25, end: 20, label: "A - intro", color: 0x0000ff },
];

let root: string;
let src: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "send-"));
  src = join(root, "render.wav");
  await makeWav(src, { sampleRate: RATE, channels: 2, bitDepth: 16, frames: SECONDS * RATE + 3, sample: (ch, i) => ((i % 30000) - 15000 + ch) / 32768 });
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A slice's file name without its audio hash (review M2), which the name tests check on their own. */
const nm = (path: string) => basename(path).replace(/ \[[0-9a-f]{6}\]\.wav$/, ".wav");

async function framesOf(path: string): Promise<number> {
  return (await readPcmFile(path, () => undefined)).frames;
}

interface FakeOpts {
  view?: "arrangement" | "session";
  /** How importIntoProject behaves: a copy into the project (default), the same path back, or a rejection. */
  importMode?: "copy" | "same" | "reject";
  /** The device name insertDevice gives back instead of the one asked for. */
  wrongDevice?: string;
  /** The Nth replaceSample (1-based) rejects. */
  failSampleAt?: number;
  /** The Nth clearClipsInRange (1-based) rejects. */
  failClearAt?: number;
  /** The Nth arrangement createAudioClip (1-based) and every one after it reject. */
  failCreateAt?: number;
  /** Live warps the arrangement clips it makes, whatever isWarped says, with these markers. */
  liveWarps?: boolean;
  /** Live gives an arrangement clip the whole file's length, whatever the markers and duration say. */
  lengthFromFile?: boolean;
  /** Live refuses an arrangement createAudioClip that has a duration. */
  rejectDuration?: boolean;
  /** The storage folder cannot be written (a file stands where its parent should be). */
  storageBroken?: boolean;
  /** The source clip's name (default "My Song"). */
  clipName?: string;
  /** The Nth createAudioTrack (1-based) rejects. */
  failTrackAt?: number;
  /** The source clip's length in seconds (default SECONDS). */
  seconds?: number;
  /**
   * Live selects each new track, so the next one goes after it: tracks come out in the order they were made. Default:
   * each goes right after the source clip's track, so several come out reversed.
   */
  newTrackSelected?: boolean;
  /** The Nth createCuePoint (1-based) rejects. */
  failCueAt?: number;
}

async function setup(opts: FakeOpts = {}) {
  const dir = await mkdtemp(join(root, "case-"));
  const temp = join(dir, "temp");
  const storage = opts.storageBroken ? join(src, "storage") : join(dir, "storage");
  const project = join(dir, "project", "Samples", "Imported");
  await mkdir(temp, { recursive: true });
  await mkdir(project, { recursive: true });
  const log: string[] = [];
  let depth = 0;
  const at = () => (depth > 0 ? "tx" : "outside");
  let samples = 0;
  let clears = 0;
  let creates = 0;
  const loaded: string[] = [];
  let tempSeen: string[] = [];

  /** Records every set of `keys` on `o` with whether it ran in a transaction. */
  const settable = <T extends object>(id: string, o: T, keys: string[], init: Record<string, unknown> = {}): T & Record<string, unknown> => {
    const store: Record<string, unknown> = { ...init };
    for (const key of keys) {
      Object.defineProperty(o, key, {
        enumerable: true,
        get: () => store[key],
        set: (v) => {
          log.push(`set ${id}.${key}=${typeof v === "object" ? JSON.stringify(v) : v}@${at()}`);
          store[key] = v;
        },
      });
    }
    return o as T & Record<string, unknown>;
  };

  const simpler = (id: string) =>
    settable(id, {
      replaceSample: async (path: string) => {
        log.push(`replaceSample ${id} ${nm(path)}@${at()}`);
        if (++samples === opts.failSampleAt) throw new Error("Live refused the sample");
        await stat(path); // it must exist when Live loads it
        loaded.push(path);
        return { filePath: path };
      },
    }, ["name"], { name: "Simpler" });

  let nextId = 0;
  const device = (name: string, owner: string) => {
    const id = `${owner}/dev${nextId++}`;
    const made = opts.wrongDevice ?? name;
    log.push(`insertDevice ${owner} ${name}@${at()}`);
    if (made === "Simpler") return simpler(id);
    if (made === "Drum Rack") {
      const chains: unknown[] = [];
      return {
        name: "Drum Rack",
        chains,
        insertChain: async (index: number) => {
          const cid = `${id}/chain${chains.length}`;
          log.push(`insertChain ${index}@${at()}`);
          const chain = settable(cid, { insertDevice: async (n: string, _i: number) => device(n, cid) }, ["receivingNote"], { receivingNote: 36 });
          chains.push(chain);
          return chain;
        },
      };
    }
    return { name: made };
  };

  const tempo = 120;
  const tracks: unknown[] = [];
  const sourceTrack = { id: "source" };
  tracks.push({ id: "other" }, sourceTrack, { id: "after" });
  // Plan 6, Task 8: scenes can be made, and every track has a slot in each.
  let sceneCount = 8;
  let cues = 0;
  const slot = (owner: string, i: number) => ({
    createMidiClip: async (length: number) => {
      log.push(`slot ${owner}[${i}].createMidiClip ${length}@${at()}`);
      return settable(`${owner}[${i}]/clip`, {}, ["name", "color", "notes"]);
    },
    createAudioClip: async (a: { filePath: string; isWarped?: boolean; loopSettings?: { startMarker: number; endMarker: number; loopStart: number; loopEnd: number; looping: boolean } }) => {
      const m = a.loopSettings;
      log.push(
        `slot ${owner}[${i}].createAudioClip ${nm(a.filePath)} warped=${a.isWarped}` +
          (m ? ` markers=${m.startMarker}..${m.endMarker} loop=${m.loopStart}..${m.loopEnd} looping=${m.looping}` : "") +
          `@${at()}`,
      );
      loaded.push(a.filePath);
      return settable(`${owner}[${i}]/clip`, { warping: a.isWarped, ...(m ? { startMarker: m.startMarker, endMarker: m.endMarker } : {}) }, ["name", "color"]);
    },
  });
  const slots = (owner: string) => {
    const made: ReturnType<typeof slot>[] = [];
    return () => {
      while (made.length < sceneCount) made.push(slot(owner, made.length));
      return [...made];
    };
  };
  let trackCreates = 0;
  let lastNew: unknown = null;

  const newTrack = (kind: string) => {
    const id = `t${tracks.length}`;
    type FakeClip = { startTime: number; endTime: number } & Record<string, unknown>;
    let clips: FakeClip[] = [];
    const mkClip = (startTime: number, endTime: number): FakeClip => {
      const c = settable(`${id}/clip${nextId++}`, { startTime, endTime }, ["name", "color", "notes"]);
      clips.push(c);
      return c;
    };
    const slotsOf = slots(id);
    const t = settable(id, {
      id,
      kind,
      get clipSlots() {
        return slotsOf();
      },
      get arrangementClips() {
        return [...clips];
      },
      insertDevice: async (name: string, _index: number) => device(name, id),
      createMidiClip: async (start: number, length: number) => {
        log.push(`${id}.createMidiClip ${start} ${length}@${at()}`);
        return mkClip(start, start + length);
      },
      createAudioClip: async (a: { filePath: string; startTime: number; duration?: number; isWarped?: boolean; loopSettings?: { startMarker: number; endMarker: number; loopStart: number; loopEnd: number; looping: boolean } }) => {
        const m = a.loopSettings;
        log.push(
          `${id}.createAudioClip ${nm(a.filePath)} at ${a.startTime}` +
            (a.duration === undefined ? "" : ` dur=${a.duration}`) +
            ` warped=${a.isWarped}` +
            (m ? ` markers=${m.startMarker}..${m.endMarker} loop=${m.loopStart}..${m.loopEnd} looping=${m.looping}` : "") +
            `@${at()}`,
        );
        if (opts.failCreateAt !== undefined && ++creates >= opts.failCreateAt) throw new Error("Live refused the clip");
        if (opts.rejectDuration && a.duration !== undefined) throw new Error("Live refused the duration");
        loaded.push(a.filePath);
        const fileSec = (await framesOf(a.filePath)) / RATE;
        const sec = m ? m.endMarker - m.startMarker : fileSec;
        const beats = opts.lengthFromFile ? (fileSec * tempo) / 60 : (a.duration ?? (sec * tempo) / 60);
        const c = mkClip(a.startTime, a.startTime + beats);
        Object.assign(c, opts.liveWarps
          ? { warping: true, startMarker: 0, endMarker: 1 }
          : { warping: a.isWarped, startMarker: m?.startMarker ?? 0, endMarker: m?.endMarker ?? sec });
        return c;
      },
      clearClipsInRange: async (a: number, b: number) => {
        log.push(`clear ${a}@${at()}`);
        if (++clears === opts.failClearAt) throw new Error("Live refused the cut");
        const left = clips.find((c) => c.startTime < a && a < c.endTime);
        if (a === b && left) {
          const right = mkClip(a, left.endTime);
          left.endTime = a;
          clips = [...clips.filter((c) => c !== right), right];
        }
      },
    }, ["name"]);
    // Live puts the track after the selected one: the source clip's track here, or the last new one.
    tracks.splice(tracks.indexOf(opts.newTrackSelected && lastNew ? lastNew : sourceTrack) + 1, 0, t);
    lastNew = t;
    log.push(`create${kind}Track@${at()}`);
    return t;
  };

  const context = {
    application: {
      song: {
        get tracks() {
          return [...tracks];
        },
        createMidiTrack: async () => newTrack("Midi"),
        createAudioTrack: async () => {
          if (++trackCreates === opts.failTrackAt) throw new Error("Live refused the track");
          return newTrack("Audio");
        },
        createScene: async (index: number) => {
          log.push(`createScene ${index}@${at()}`);
          sceneCount++;
          return settable(`scene${index}`, {}, ["name"]);
        },
        createCuePoint: async (time: number) => {
          log.push(`createCuePoint ${time}@${at()}`);
          if (++cues === opts.failCueAt) throw new Error("Live refused the locator");
          return settable(`cue${cues}`, {}, ["name"]);
        },
      },
    },
    resources: {
      importIntoProject: async (path: string) => {
        tempSeen = await readdir(join(path, ".."));
        log.push(`import ${nm(path)}`);
        if (opts.importMode === "reject") throw new Error("No project folder");
        if (opts.importMode === "same") return path;
        const dest = join(project, basename(path));
        await copyFile(path, dest);
        return dest;
      },
    },
    withinTransaction: <T,>(fn: () => T): T => {
      depth++;
      try {
        return fn();
      } finally {
        depth--;
      }
    },
  };

  const info = {
    view: opts.view ?? "arrangement",
    clip: {},
    track: sourceTrack,
    sceneIndex: opts.view === "session" ? 2 : undefined,
    startTime: 8,
    lengthBeats: (opts.seconds ?? SECONDS) * 2,
    startMarker: 0,
    endMarker: (opts.seconds ?? SECONDS) * 2,
    warped: true,
    filePath: "/samples/song.wav",
    color: 0x123456,
    name: opts.clipName ?? "My Song",
  } as unknown as ClipInfo;

  const logs: unknown[][] = [];
  const env = { tempDir: temp, storageDir: storage, log: (...a: unknown[]) => void logs.push(a) };
  const send = (r: Partial<SendRequest>) =>
    executeSend(context as never, info, { target: "simpler", source: "mix", index: 0, sections: SECTIONS, sourcePath: src, tempo, ...r }, env);
  return { send, log, loaded, project, temp, storage, tracks, logs, tempSeen: () => tempSeen };
}

describe("file names", () => {
  it("are made safe for macOS and Windows and never empty", () => {
    expect(safeFileName('My: "Song"/mix\\take*?<1>|')).toBe("My_ _Song__mix_take___1__");
    expect(safeFileName("  ..hidden  ")).toBe("hidden");
    expect(safeFileName("trailing. ")).toBe("trailing");
    expect(safeFileName("tab\there\nnew")).toBe("tab_here_new");
    expect(safeFileName("")).toBe("Untitled");
    expect(safeFileName("A′ - chorus")).toBe("A′ - chorus");
    expect(Buffer.byteLength(safeFileName("é".repeat(300)))).toBeLessThanOrEqual(200);
  });
  it("re-review N1: a long name is shortened before its hash, so it keeps the hash", () => {
    const sha = "abcdef" + "0".repeat(58);
    const name = withHash("Long ".repeat(80) + "- chorus - vocals", sha);
    expect(name.endsWith(" [abcdef]")).toBe(true);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200);
    expect(uniqueFileNames([name])[0].endsWith(" [abcdef].wav")).toBe(true);
    expect(withHash("Song - A - mix", sha)).toBe("Song - A - mix [abcdef]");
    // Key review M3: the key is kept with the hash.
    expect(withHash("Song - A - mix", sha, "Dm")).toBe("Song - A - mix - Dm [abcdef]");
    const keyed = withHash("Long ".repeat(80) + "- chorus - vocals", sha, "Bbm");
    expect(keyed.endsWith(" - Bbm [abcdef]")).toBe(true);
    expect(Buffer.byteLength(keyed)).toBeLessThanOrEqual(200);
    expect(uniqueFileNames([keyed])[0].endsWith(" - Bbm [abcdef].wav")).toBe(true);
  });

  it("are unique within a send, case-insensitively", () => {
    expect(uniqueFileNames(["S - A - mix", "S - B - mix", "S - A - mix", "s - a - MIX", "S - A - mix 2"])).toEqual([
      "S - A - mix.wav",
      "S - B - mix.wav",
      "S - A - mix 2.wav",
      "s - a - MIX 3.wav",
      "S - A - mix 2 2.wav",
    ]);
  });
});

describe("section beats and pad notes", () => {
  it("go by Apply's edges in the Arrangement and by the song tempo in Session", () => {
    const arr = { view: "arrangement", startTime: 8, lengthBeats: 40, startMarker: 0, endMarker: 40, warped: true } as unknown as ClipInfo;
    expect(sectionBeats(arr, SECTIONS, 120)).toEqual({ starts: [0, 10, 24.5], ends: [10, 24.5, 40], length: 40 });
    const ses = { view: "session", startTime: 0, lengthBeats: 40, startMarker: 0, endMarker: 40, warped: false } as unknown as ClipInfo;
    expect(sectionBeats(ses, SECTIONS, 90)).toEqual({ starts: [0, 7.5, 18.375], ends: [7.5, 18.375, 30], length: 30 });
  });
  it("Plan 6: give each section its own start and end when rests are left out; the last runs to the clip's end only when it ends there", () => {
    const arr = { view: "arrangement", startTime: 8, lengthBeats: 40, startMarker: 0, endMarker: 40, warped: true } as unknown as ClipInfo;
    const gapped = [SECTIONS[0], { ...SECTIONS[2], start: 13, end: 18 }];
    expect(sectionBeats(arr, gapped, 120, SECONDS)).toEqual({ starts: [0, 26], ends: [10, 36], length: 40 });
    expect(sectionBeats(arr, [{ ...SECTIONS[0], start: 2 }, { ...SECTIONS[2], start: 13 }], 120, SECONDS)).toEqual({ starts: [4, 26], ends: [10, 40], length: 40 });
    const ses = { view: "session", startTime: 0, lengthBeats: 40, startMarker: 0, endMarker: 40, warped: false } as unknown as ClipInfo;
    expect(sectionBeats(ses, gapped, 90, SECONDS)).toEqual({ starts: [0, 19.5], ends: [7.5, 27], length: 30 });
  });
  it("put pad k at section k's start, as long as the section, from C1 up; an empty section gets no note", () => {
    expect(padNotes({ starts: [0, 10, 10], ends: [10, 10, 24] }, [0, 1, 2], 3)).toEqual([
      { pitch: 36, startTime: 0, duration: 10, velocity: 100 },
      { pitch: 38, startTime: 10, duration: 14, velocity: 100 },
    ]);
  });
});

describe("pad plan (Plan 6)", () => {
  it("gives the distinct labels pads in order of first occurrence", () => {
    const sections = ["drums 1", "drums 2", "drums 1", "drums 1′", "drums 2"].map((label, i) => ({ start: i, end: i + 1, label, color: 0 }));
    expect(padPlan(sections)).toEqual({ padOf: [0, 1, 0, 2, 1], firsts: [0, 1, 3] });
  });
});

describe("executeSend", () => {
  it("Simpler: one slice into the project, then a MIDI track with a Simpler holding the imported copy, named in one transaction", async () => {
    const f = await setup();
    const r = await f.send({ target: "simpler", source: "mix", index: 1 });
    expect(f.log).toEqual([
      "import My Song - B - mix.wav",
      "createMidiTrack@outside",
      "insertDevice t3 Simpler@outside",
      "replaceSample t3/dev0 My Song - B - mix.wav@outside",
      "set t3.name=B (mix)@tx",
    ]);
    expect(r).toEqual({ steps: 4, notes: [] });
    // The Simpler loads the project's copy, cut from 5 s to 12.25 s, frame-accurately.
    expect(f.loaded).toEqual([expect.stringMatching(/^.*[\\/]Samples[\\/]Imported[\\/]My Song - B - mix \[[0-9a-f]{6}\]\.wav$/)]);
    expect(await framesOf(f.loaded[0])).toBe(12250 - 5000);
    // The temp folder is gone, and the slice was written into a folder of its own.
    expect(await readdir(f.temp)).toEqual([]);
    expect(f.tempSeen().map(nm)).toEqual(["My Song - B - mix.wav"]);
    expect(f.logs.some((l) => /track 3; the source clip's track is 2 \(right after it\)/.test(String(l[0])))).toBe(true);
  });

  it("review M2: a slice's name ends in a hash of its audio, so a later send with other edges never reuses a name", async () => {
    const f = await setup();
    await f.send({ target: "simpler", index: 1 });
    await f.send({ target: "simpler", index: 1 }); // the same audio: the same name
    await f.send({ target: "simpler", index: 1, sections: [SECTIONS[0], { ...SECTIONS[1], end: 12 }, { ...SECTIONS[2], start: 12 }] });
    const names = f.loaded.map((p) => basename(p));
    expect(names[0]).toMatch(/^My Song - B - mix \[[0-9a-f]{6}\]\.wav$/);
    expect(names[1]).toBe(names[0]);
    expect(names[2]).not.toBe(names[0]);
    expect(nm(names[2])).toBe("My Song - B - mix.wav");
  });

  it("Simpler from a stem names the track after it", async () => {
    const f = await setup();
    await f.send({ target: "simpler", source: "drums", index: 2 });
    expect(f.log.at(-1)).toBe("set t3.name=A - intro (drums)@tx");
    expect(f.loaded.map(nm)).toEqual(["My Song - A - intro - drums.wav"]);
    // The last section runs to the file's end (the render is 3 frames longer than its sections).
    expect(await framesOf(f.loaded[0])).toBe(SECONDS * RATE + 3 - 12250);
  });

  it("Drum Rack: a pad per section from C1 in time order (repeats get their own), a MIDI clip that plays them, one naming transaction", async () => {
    const f = await setup();
    const r = await f.send({ target: "drumRack", source: "bass", index: 1 });
    // The repeat's audio differs, so its hash tells its file apart (review M2).
    const names = ["My Song - A - intro - bass.wav", "My Song - B - bass.wav", "My Song - A - intro - bass.wav"];
    expect(f.log).toEqual([
      ...names.map((n) => `import ${n}`),
      "createMidiTrack@outside",
      "insertDevice t3 Drum Rack@outside",
      ...names.flatMap((n, k) => [`insertChain ${k}@outside`, `insertDevice t3/dev0/chain${k} Simpler@outside`, `replaceSample t3/dev0/chain${k}/dev${k + 1} ${n}@outside`]),
      "t3.createMidiClip 8 40@outside",
      "set t3.name=My Song (bass) sections@tx",
      "set t3/dev0/chain0.receivingNote=36@tx",
      "set t3/dev0/chain1.receivingNote=37@tx",
      "set t3/dev0/chain2.receivingNote=38@tx",
      `set t3/clip4.notes=${JSON.stringify([
        { pitch: 36, startTime: 0, duration: 10, velocity: 100 },
        { pitch: 37, startTime: 10, duration: 14.5, velocity: 100 },
        { pitch: 38, startTime: 24.5, duration: 15.5, velocity: 100 },
      ])}@tx`,
      "set t3/clip4.name=My Song@tx",
      `set t3/clip4.color=${0x123456}@tx`,
    ]);
    expect(r.steps).toBe(3 + 3 * 3 + 1); // track, rack, clip, 3 per pad, the transaction
    expect(r.notes).toEqual([]);
    expect(await Promise.all(f.loaded.map(framesOf))).toEqual([5000, 7250, SECONDS * RATE + 3 - 12250]);
    expect(new Set(f.loaded).size).toBe(3);
  });

  it("Drum Rack in Session puts the MIDI clip in the source clip's scene row, at the song tempo", async () => {
    const f = await setup({ view: "session" });
    await f.send({ target: "drumRack", source: "mix", index: 0 });
    expect(f.log).toContain("slot t3[2].createMidiClip 40@outside");
    expect(f.log.find((l) => l.startsWith("set t3[2]/clip.notes"))).toContain('"startTime":24.5');
  });

  it("Drum Rack holds at most the pads from C1 to G8, and says so", async () => {
    const many: Section[] = Array.from({ length: MAX_PADS + 4 }, (_, i) => ({ start: i * 0.2, end: (i + 1) * 0.2, label: `S${i}`, color: i }));
    const f = await setup();
    const r = await f.send({ target: "drumRack", source: "mix", index: 0, sections: many });
    expect(MAX_PADS).toBe(92);
    expect(f.log.filter((l) => l.startsWith("insertChain"))).toHaveLength(92);
    expect(f.log.filter((l) => l.includes("receivingNote")).at(-1)).toBe("set t3/dev0/chain91.receivingNote=127@tx");
    expect(r.notes).toEqual(["A Drum Rack's pads go from C1 up to G8, so only the first 92 of the 96 sections were sent."]);
  });

  // Plan 6: a send from a pattern lane: the lane's slices, rests left out (a rest at 12–13 s here).
  const SLICES: Section[] = [
    { start: 0, end: 4, label: "drums 1", color: 1 },
    { start: 4, end: 8, label: "drums 2", color: 2 },
    { start: 8, end: 12, label: "drums 1", color: 1 },
    { start: 13, end: 16, label: "drums 1′", color: 3 },
    { start: 16, end: 20, label: "drums 2", color: 2 },
  ];

  it("Plan 6: Drum Rack from a lane: a pad per pattern, loaded with its first slice, and a note per slice on its pattern's pad", async () => {
    const f = await setup({ clipName: "Song" });
    const r = await f.send({ target: "drumRack", source: "drums", unit: "patterns", index: 2, sections: SLICES, durationSec: SECONDS });
    expect(f.log.filter((l) => l.startsWith("insertChain"))).toHaveLength(3);
    // Task 7 review: the label carries the stem already, so the file names do not repeat it.
    expect(f.loaded.map(nm)).toEqual(["Song - drums 1.wav", "Song - drums 2.wav", "Song - drums 1′.wav"]);
    expect(await Promise.all(f.loaded.map(framesOf))).toEqual([4000, 4000, 3000]);
    const notes = JSON.parse(f.log.find((l) => l.includes("clip") && l.includes(".notes="))!.split(".notes=")[1].replace(/@tx$/, ""));
    expect(notes.map((n: { pitch: number }) => n.pitch)).toEqual([36, 37, 36, 38, 37]);
    expect(notes).toEqual([
      { pitch: 36, startTime: 0, duration: 8, velocity: 100 },
      { pitch: 37, startTime: 8, duration: 8, velocity: 100 },
      { pitch: 36, startTime: 16, duration: 8, velocity: 100 },
      { pitch: 38, startTime: 26, duration: 6, velocity: 100 },
      { pitch: 37, startTime: 32, duration: 8, velocity: 100 },
    ]);
    expect(f.log).toContain("t3.createMidiClip 8 40@outside"); // the whole clip, rests and all
    expect(f.log).toContain("set t3.name=Song (drums) patterns@tx");
    expect(f.log.filter((l) => l.includes("receivingNote"))).toEqual(["set t3/dev0/chain0.receivingNote=36@tx", "set t3/dev0/chain1.receivingNote=37@tx", "set t3/dev0/chain2.receivingNote=38@tx"]);
    expect(r).toEqual({ steps: 3 + 3 * 3 + 1, notes: [] });
  });

  it("Task 7 review: a Session Drum Rack from a lane gets a MIDI clip as long as the clip, trailing rest and all", async () => {
    const f = await setup({ view: "session" });
    await f.send({ target: "drumRack", source: "drums", unit: "patterns", index: 0, sections: SLICES.slice(0, 4), durationSec: SECONDS });
    expect(f.log).toContain("slot t3[2].createMidiClip 40@outside"); // beats(20 s) at 120 BPM, not the last slice's end (32)
  });

  it("Plan 6: a lane slice before a trailing rest does not run to the file's end", async () => {
    const f = await setup();
    await f.send({ target: "simpler", source: "bass", unit: "patterns", index: 1, sections: [SLICES[0], { ...SLICES[1], end: 10 }], durationSec: SECONDS });
    expect(await framesOf(f.loaded[0])).toBe(6000);
  });

  it("Plan 6, Review Focus 5: patterns past the pads from C1 to G8 get no pad and no notes, and the send says so", async () => {
    const many: Section[] = Array.from({ length: 100 }, (_, i) => ({ start: i * 0.2, end: (i + 1) * 0.2, label: `other ${i + 1}`, color: i }));
    const f = await setup();
    const r = await f.send({ target: "drumRack", source: "other", unit: "patterns", index: 0, sections: many, durationSec: SECONDS });
    expect(f.log.filter((l) => l.startsWith("insertChain"))).toHaveLength(92);
    const notes = JSON.parse(f.log.find((l) => l.includes(".notes="))!.split(".notes=")[1].replace(/@tx$/, ""));
    expect(notes).toHaveLength(92);
    expect(Math.max(...notes.map((n: { pitch: number }) => n.pitch))).toBe(127);
    expect(r.notes).toEqual(["A Drum Rack's pads go from C1 up to G8, so only the first 92 of the 100 patterns were sent."]);
  });

  it("Plan 6: audio, the whole stem from a lane, Arrangement: a clip per slice at its place, and nothing in the rests", async () => {
    const f = await setup();
    const sections = [
      { start: 0, end: 4, label: "other 1", color: 1 },
      { start: 6, end: 10, label: "other 2", color: 2 },
    ];
    const r = await f.send({ target: "audioWhole", source: "other", unit: "patterns", index: 0, sections, durationSec: SECONDS });
    expect(f.log.filter((l) => l.includes("createAudioClip"))).toEqual([
      "t3.createAudioClip My Song - other.wav at 8 dur=8 warped=false markers=0..4 loop=0..4 looping=false@outside",
      "t3.createAudioClip My Song - other.wav at 20 dur=8 warped=false markers=6..10 loop=6..10 looping=false@outside",
    ]);
    expect(f.log.filter((l) => /clip\d+\.name/.test(l))).toEqual(["set t3/clip0.name=other 1@tx", "set t3/clip1.name=other 2@tx"]);
    expect(r.steps).toBe(1 + 2 + 1);
    expect(f.logs.some((l) => /was made unwarped, but/.test(String(l[0])))).toBe(false);
  });

  it("Task 7 review: audio, the whole stem from a lane, Arrangement: a last slice that ends at the clip's end runs to the file's end", async () => {
    const f = await setup();
    const sections = [
      { start: 0, end: 4, label: "other 1", color: 1 },
      { start: 6, end: SECONDS, label: "other 2", color: 2 },
    ];
    await f.send({ target: "audioWhole", source: "other", unit: "patterns", index: 0, sections, durationSec: SECONDS });
    const file = (SECONDS * RATE + 3) / RATE;
    expect(f.log.filter((l) => l.includes("createAudioClip"))).toEqual([
      "t3.createAudioClip My Song - other.wav at 8 dur=8 warped=false markers=0..4 loop=0..4 looping=false@outside",
      `t3.createAudioClip My Song - other.wav at 20 dur=28 warped=false markers=6..${file} loop=6..${file} looping=false@outside`,
    ]);
  });

  it("audio, one section: a clip at the section's place in the Arrangement, unwarped, named and coloured like the section", async () => {
    const f = await setup();
    const r = await f.send({ target: "audioSection", source: "vocals", index: 1 });
    expect(f.log.slice(1)).toEqual([
      "createAudioTrack@outside",
      "t3.createAudioClip My Song - B - vocals.wav at 18 warped=false@outside",
      "set t3.name=B (vocals)@tx",
      "set t3/clip0.name=B@tx",
      `set t3/clip0.color=${0x00ff00}@tx`,
    ]);
    expect(r.steps).toBe(3);
  });

  it("audio, one section, in Session: the source clip's scene row", async () => {
    const f = await setup({ view: "session" });
    await f.send({ target: "audioSection", source: "mix", index: 0 });
    expect(f.log).toContain("slot t3[2].createAudioClip My Song - A - intro - mix.wav warped=false@outside");
  });

  it("audio, the whole stem, Arrangement: one unwarped clip per section at its song time, its file seconds as markers, no split", async () => {
    const f = await setup();
    const r = await f.send({ target: "audioWhole", source: "other", index: 2 });
    const file = (SECONDS * RATE + 3) / RATE; // the last piece runs to the file's end
    expect(f.log.slice(0, 5)).toEqual([
      "import My Song - other.wav",
      "createAudioTrack@outside",
      "t3.createAudioClip My Song - other.wav at 8 dur=10 warped=false markers=0..5 loop=0..5 looping=false@outside",
      "t3.createAudioClip My Song - other.wav at 18 dur=14.5 warped=false markers=5..12.25 loop=5..12.25 looping=false@outside",
      // The last runs to the clip's end in beats; its markers run to the file's end, 3 frames on.
      `t3.createAudioClip My Song - other.wav at 32.5 dur=15.5 warped=false markers=12.25..${file} loop=12.25..${file} looping=false@outside`,
    ]);
    expect(f.log.some((l) => l.startsWith("clear"))).toBe(false);
    expect(f.log.slice(5)).toEqual([
      "set t3.name=My Song (other)@tx",
      "set t3/clip0.name=A - intro@tx",
      `set t3/clip0.color=${0xff0000}@tx`,
      "set t3/clip1.name=B@tx",
      `set t3/clip1.color=${0x00ff00}@tx`,
      "set t3/clip2.name=A - intro@tx",
      `set t3/clip2.color=${0x0000ff}@tx`,
    ]);
    expect(r.steps).toBe(1 + 3 + 1); // track, a clip per section, the names
    expect(await framesOf(f.loaded[0])).toBe(SECONDS * RATE + 3);
    expect(f.logs.some((l) => /was made unwarped, but/.test(String(l[0])))).toBe(false);
  });

  it("audio, the whole stem, Arrangement: a section too short to be a piece is dropped, as Apply drops it", async () => {
    const f = await setup();
    const sections = [SECTIONS[0], { ...SECTIONS[1], end: 5 + 1e-7 }, { ...SECTIONS[2], start: 5 + 1e-7 }];
    const r = await f.send({ target: "audioWhole", source: "mix", index: 0, sections });
    expect(f.log.filter((l) => l.includes("createAudioClip")).map((l) => l.split(" at ")[1].split(" ")[0])).toEqual(["8", `${8 + ((5 + 1e-7) * 120) / 60}`]);
    // The second clip made is section 3's (stem-fix review M2): its name and colour, not the dropped one's.
    expect(f.log.filter((l) => /clip\d+\.(name|color)/.test(l))).toEqual([
      "set t3/clip0.name=A - intro@tx",
      `set t3/clip0.color=${0xff0000}@tx`,
      "set t3/clip1.name=A - intro@tx",
      `set t3/clip1.color=${0x0000ff}@tx`,
    ]);
    expect(r.steps).toBe(1 + 2 + 1);
  });

  it("stem-fix review I1: a clip Live makes another length than it was given is said on the log", async () => {
    const f = await setup({ lengthFromFile: true });
    await f.send({ target: "audioWhole", source: "drums", index: 0 });
    const lines = f.logs.map((l) => String(l[0])).filter((l) => l.includes("was made unwarped, but"));
    expect(lines).toEqual([
      `Song Sections: the clip "A - intro" was made unwarped, but it spans beats 8..${8 + 40.006}, not 8..18`,
      `Song Sections: the clip "B" was made unwarped, but it spans beats 18..${18 + 40.006}, not 18..32.5`,
      `Song Sections: the clip "A - intro" was made unwarped, but it spans beats 32.5..${32.5 + 40.006}, not 32.5..48`,
    ]);
  });

  it("stem-fix review I1: a duration Live refuses is logged and the clip is made without one", async () => {
    const f = await setup({ rejectDuration: true });
    const r = await f.send({ target: "audioWhole", source: "drums", index: 0 });
    const creates = f.log.filter((l) => l.includes("createAudioClip"));
    expect(creates).toHaveLength(6);
    expect(creates.filter((l) => l.includes(" dur="))).toHaveLength(3);
    expect(f.logs.filter((l) => /Live refused the clip "A - intro" with a duration of 10 beats/.test(String(l[0])))).toHaveLength(1);
    expect(r.steps).toBe(1 + 3 + 1); // a refused create changes nothing
  });

  it("audio, the whole stem, Arrangement: a clip Live warped anyway is said on the log", async () => {
    const f = await setup({ liveWarps: true });
    await f.send({ target: "audioWhole", source: "bass", index: 0, sections: SECTIONS.slice(0, 1).map((s) => ({ ...s, end: 20 })) });
    expect(f.logs.map((l) => String(l[0]))).toContainEqual('Song Sections: the clip "A - intro" was made unwarped, but warping is true and markers are 0..1, not 0..20.003');
  });

  it("audio, the whole stem, Session: one clip named after the stem in the source's scene row", async () => {
    const f = await setup({ view: "session" });
    const r = await f.send({ target: "audioWhole", source: "mix", index: 0 });
    expect(f.log.slice(1)).toEqual([
      "createAudioTrack@outside",
      "slot t3[2].createAudioClip My Song - mix.wav warped=false@outside",
      "set t3.name=My Song (mix)@tx",
      "set t3[2]/clip.name=My Song (mix)@tx",
      `set t3[2]/clip.color=${0x123456}@tx`,
    ]);
    expect(r.steps).toBe(3);
  });

  it("review I1: a rejected import (an unsaved Set?) falls back to a copy in storage, and the user is told to Collect All and Save", async () => {
    const f = await setup({ importMode: "reject" });
    const r = await f.send({ target: "drumRack" });
    expect(f.loaded).toHaveLength(3);
    expect(f.loaded.every((p) => p.startsWith(join(f.storage, "sent")))).toBe(true);
    expect(await Promise.all(f.loaded.map(framesOf))).toEqual([5000, 7250, SECONDS * RATE + 3 - 12250]);
    expect(r.notes).toEqual([expect.stringMatching(/not saved yet.*Collect All and Save/)]);
    expect(f.logs.some((l) => /the import failed: No project folder/.test(String(l[0])))).toBe(true);
    expect(await readdir(f.temp)).toEqual([]);
  });

  it("an import that fails with no storage copy to fall back on changes nothing and leaves no temp files", async () => {
    const f = await setup({ importMode: "reject", storageBroken: true });
    const e = await f.send({ target: "drumRack" }).catch((x) => x);
    expect(e).toBeInstanceOf(SendError);
    expect((e as SendError).steps).toBe(0);
    expect(sendFailedMessage(e)).toBe("Song Sections couldn't send the sections. Your Set was not changed.");
    expect(f.log.some((l) => l.startsWith("create"))).toBe(false);
    expect(await readdir(f.temp)).toEqual([]);
  });

  it("a slice Live did not copy is kept in storage, not deleted from under the Set, and the user is told", async () => {
    const f = await setup({ importMode: "same" });
    const r = await f.send({ target: "simpler", index: 0 });
    expect(f.loaded).toHaveLength(1);
    expect(f.loaded[0].startsWith(join(f.storage, "sent"))).toBe(true);
    expect(await framesOf(f.loaded[0])).toBe(5000);
    expect(await readdir(f.temp)).toEqual([]);
    expect(r.notes).toEqual([expect.stringMatching(/Collect All and Save/)]);
  });

  it("a failure midway stops, still names what was made, counts it for Undo and cleans up", async () => {
    const f = await setup({ failSampleAt: 2 });
    const e = (await f.send({ target: "drumRack", source: "mix" }).catch((x) => x)) as SendError;
    expect(e).toBeInstanceOf(SendError);
    expect(f.log.filter((l) => l.startsWith("insertChain"))).toHaveLength(2); // stopped at the second pad
    expect(f.log.some((l) => l.includes("createMidiClip"))).toBe(false);
    expect(f.log.filter((l) => l.endsWith("@tx"))).toEqual([
      "set t3.name=My Song (mix) sections@tx",
      "set t3/dev0/chain0.receivingNote=36@tx",
      "set t3/dev0/chain1.receivingNote=37@tx",
    ]);
    // track, rack, pad 1 (chain, Simpler, sample), pad 2's chain and Simpler, the naming transaction
    expect(e.steps).toBe(1 + 1 + 3 + 2 + 1);
    expect(sendFailedMessage(e)).toBe(
      "Song Sections couldn't finish sending the sections. It made a new MIDI track with a Drum Rack and 1 of 3 pads; use Edit › Undo 8 times to remove it.",
    );
    expect(await readdir(f.temp)).toEqual([]);
  });

  it("review I2: a device name Live does not know stops, counting the device Live made", async () => {
    const f = await setup({ wrongDevice: "Audio Effect Rack" });
    const e = (await f.send({ target: "simpler" }).catch((x) => x)) as SendError;
    expect(e.message).toMatch(/insertDevice\("Simpler"\) made an Audio Effect Rack/);
    expect(e.steps).toBe(3); // the track, the device Live made, the name
    expect(e.made).toBe("a new MIDI track with an Audio Effect Rack");
    expect(sendFailedMessage(e)).toMatch(/use Edit › Undo 3 times/);
  });

  it("review I2: the same for the Drum Rack", async () => {
    const f = await setup({ wrongDevice: "Instrument Rack" });
    const e = (await f.send({ target: "drumRack" }).catch((x) => x)) as SendError;
    expect(e.message).toMatch(/insertDevice\("Drum Rack"\) made an Instrument Rack/);
    expect(e.steps).toBe(3);
    expect(e.made).toBe("a new MIDI track with an Instrument Rack");
  });

  it("a failure in the whole-stem Arrangement send stops, names the clips already made and counts them", async () => {
    const f = await setup({ failCreateAt: 2 });
    const e = (await f.send({ target: "audioWhole", source: "bass" }).catch((x) => x)) as SendError;
    expect(e).toBeInstanceOf(SendError);
    expect(f.log.filter((l) => l.includes("createAudioClip"))).toHaveLength(3); // the second is tried again without a duration
    expect(f.log.filter((l) => l.endsWith("@tx"))).toEqual([
      "set t3.name=My Song (bass)@tx",
      "set t3/clip0.name=A - intro@tx",
      `set t3/clip0.color=${0xff0000}@tx`,
    ]);
    expect(e.steps).toBe(1 + 1 + 1); // track, the one clip made, the names
    expect(e.made).toBe("a new audio track with a clip");
  });
});

describe("Send all stems to new tracks (Plan 6, Task 8)", () => {
  // The brief's song: 16 s, sections A - intro 0–10 and B - verse 10–16; the bass and the vocals rest throughout.
  const SONG_SEC = 16;
  const SONG: Section[] = [
    { start: 0, end: 10, label: "A - intro", color: 0xa },
    { start: 10, end: 16, label: "B - verse", color: 0xb },
  ];
  const STEMS: Record<StemName, Section[]> = {
    drums: [
      { start: 0, end: 8, label: "drums 1", color: 0xd1 },
      { start: 8, end: 16, label: "drums 2", color: 0xd2 },
    ],
    bass: [],
    vocals: [],
    other: [
      { start: 0, end: 4, label: "other 1", color: 0x01 },
      { start: 4, end: 12, label: "other 2", color: 0x02 },
      { start: 12, end: 16, label: "other 1", color: 0x01 },
    ],
  };
  let paths16: Record<StemName, string>;
  let paths130: Record<StemName, string>;
  const stemFiles = async (seconds: number) => {
    const dir = await mkdtemp(join(root, `stems${seconds}-`));
    const paths = Object.fromEntries(STEM_NAMES.map((s) => [s, join(dir, `${s}.wav`)])) as Record<StemName, string>;
    for (const s of STEM_NAMES) await makeWav(paths[s], { sampleRate: RATE, channels: 2, bitDepth: 16, frames: seconds * RATE + 3, sample: (ch, i) => ((i % 30000) - 15000 + ch) / 32768 });
    return paths;
  };
  beforeAll(async () => {
    paths16 = await stemFiles(SONG_SEC);
    paths130 = await stemFiles(130);
  });
  const allStems = (over: Partial<SendRequest> = {}): Partial<SendRequest> => ({
    target: "allStems",
    source: "mix",
    index: 0,
    sections: SONG,
    stems: STEMS,
    stemPaths: paths16,
    durationSec: SONG_SEC,
    ...over,
  });
  const file16 = (SONG_SEC * RATE + 3) / RATE;

  it("sceneStarts: the union of every stem's cuts and every section start, from 0, without the end", () => {
    expect(sceneStarts(STEMS, SONG, SONG_SEC)).toEqual([0, 4, 8, 10, 12]);
  });

  it("sceneStarts: points closer than a second merge, into the earlier, and one within a second of the end goes", () => {
    const stems = { ...STEMS, drums: [{ start: 0, end: 8.5, label: "drums 1", color: 1 }], other: [{ start: 0, end: 8, label: "other 1", color: 1 }, { start: 8, end: 15.6, label: "other 2", color: 2 }] };
    expect(sceneStarts(stems, [{ ...SONG[0], end: 16 }], SONG_SEC)).toEqual([0, 8]);
  });

  it("Session: a scene per start below the source's, named <section> <n>; each stem's clip over the scene, named by its slice; a resting stem's slot stays empty", async () => {
    const f = await setup({ view: "session", seconds: SONG_SEC, newTrackSelected: true });
    const r = await f.send(allStems());
    // The four tracks first, in stem order; then the scenes below the source clip's (scene 2), in ascending order.
    expect(f.log.filter((l) => l.startsWith("create"))).toEqual([
      ...STEM_NAMES.map(() => "createAudioTrack@outside"),
      ...[3, 4, 5, 6, 7].map((i) => `createScene ${i}@outside`),
    ]);
    expect(f.log.filter((l) => /^set scene\d+\.name/.test(l))).toEqual([
      "set scene3.name=A - intro 1@tx",
      "set scene4.name=A - intro 2@tx",
      "set scene5.name=A - intro 3@tx",
      "set scene6.name=B - verse 1@tx",
      "set scene7.name=B - verse 2@tx",
    ]);
    const creates = f.log.filter((l) => l.includes("createAudioClip"));
    // t3 drums, t4 bass, t5 vocals, t6 other: the drums and the other in every scene, the bass and the vocals in none.
    expect(creates).toEqual([
      "slot t3[3].createAudioClip My Song - drums.wav warped=false markers=0..4 loop=0..4 looping=false@outside",
      "slot t3[4].createAudioClip My Song - drums.wav warped=false markers=4..8 loop=4..8 looping=false@outside",
      "slot t3[5].createAudioClip My Song - drums.wav warped=false markers=8..10 loop=8..10 looping=false@outside",
      "slot t3[6].createAudioClip My Song - drums.wav warped=false markers=10..12 loop=10..12 looping=false@outside",
      `slot t3[7].createAudioClip My Song - drums.wav warped=false markers=12..${file16} loop=12..${file16} looping=false@outside`,
      "slot t6[3].createAudioClip My Song - other.wav warped=false markers=0..4 loop=0..4 looping=false@outside",
      "slot t6[4].createAudioClip My Song - other.wav warped=false markers=4..8 loop=4..8 looping=false@outside",
      "slot t6[5].createAudioClip My Song - other.wav warped=false markers=8..10 loop=8..10 looping=false@outside",
      "slot t6[6].createAudioClip My Song - other.wav warped=false markers=10..12 loop=10..12 looping=false@outside",
      `slot t6[7].createAudioClip My Song - other.wav warped=false markers=12..${file16} loop=12..${file16} looping=false@outside`,
    ]);
    // Scene 2 (4–8 s): the drums clip is drums 1, over 4–8 s, coloured as the slice.
    expect(f.log).toContain("set t3[4]/clip.name=drums 1@tx");
    expect(f.log).toContain(`set t3[4]/clip.color=${0xd1}@tx`);
    expect(f.log.filter((l) => /^set t6\[\d\]\/clip\.name/.test(l))).toEqual([
      "set t6[3]/clip.name=other 1@tx",
      "set t6[4]/clip.name=other 2@tx",
      "set t6[5]/clip.name=other 2@tx",
      "set t6[6]/clip.name=other 2@tx",
      "set t6[7]/clip.name=other 1@tx",
    ]);
    // The vocals (t5) and the bass (t4) have no clip at all, and no file of theirs was sent.
    expect(f.log.some((l) => /t[45]\[/.test(l))).toBe(false);
    expect(f.log.filter((l) => l.startsWith("import"))).toEqual(["import My Song - drums.wav", "import My Song - other.wav"]);
    expect(f.log.filter((l) => /^set t\d\.name/.test(l))).toEqual(STEM_NAMES.map((s, k) => `set t${3 + k}.name=My Song (${s})@tx`));
    expect(r).toEqual({ steps: 4 + 5 + 10 + 1, notes: [] });
    expect(f.logs.some((l) => /was made unwarped, but/.test(String(l[0])))).toBe(false);
  });

  it("Arrangement: 4 tracks, each with an unwarped clip only at its own non-rest slices", async () => {
    const f = await setup({ seconds: SONG_SEC, newTrackSelected: true });
    const r = await f.send(allStems());
    expect(f.log.filter((l) => l.startsWith("create") && !l.startsWith("createCuePoint"))).toEqual(STEM_NAMES.map(() => "createAudioTrack@outside"));
    expect(f.log.filter((l) => l.includes("createAudioClip"))).toEqual([
      "t3.createAudioClip My Song - drums.wav at 8 dur=16 warped=false markers=0..8 loop=0..8 looping=false@outside",
      `t3.createAudioClip My Song - drums.wav at 24 dur=16 warped=false markers=8..${file16} loop=8..${file16} looping=false@outside`,
      "t6.createAudioClip My Song - other.wav at 8 dur=8 warped=false markers=0..4 loop=0..4 looping=false@outside",
      "t6.createAudioClip My Song - other.wav at 16 dur=16 warped=false markers=4..12 loop=4..12 looping=false@outside",
      `t6.createAudioClip My Song - other.wav at 32 dur=8 warped=false markers=12..${file16} loop=12..${file16} looping=false@outside`,
    ]);
    expect(f.log.filter((l) => /clip\d+\.name/.test(l))).toEqual([
      "set t3/clip0.name=drums 1@tx",
      "set t3/clip1.name=drums 2@tx",
      "set t6/clip2.name=other 1@tx",
      "set t6/clip3.name=other 2@tx",
      "set t6/clip4.name=other 1@tx",
    ]);
    expect(f.log).toContain(`set t6/clip3.color=${0x02}@tx`);
    expect(f.log.filter((l) => /^set t\d\.name/.test(l))).toEqual(STEM_NAMES.map((s, k) => `set t${3 + k}.name=My Song (${s})@tx`));
    expect(f.log.some((l) => l.startsWith("createScene"))).toBe(false);
    expect(r).toEqual({ steps: 4 + 5 + 2 + 1, notes: [] });
  });

  // Matt (Live, 3 Nov): "uses the split from the stems and markers from the mix": in the Arrangement the send also
  // puts a locator at each of the dialog's sections, as Apply's Output Locators does; the source clip is left alone.
  it("Arrangement: a locator at each section's start, named by it, after the tracks and clips; the source clip untouched", async () => {
    const f = await setup({ seconds: SONG_SEC, newTrackSelected: true });
    const r = await f.send(allStems());
    const creates = f.log.filter((l) => l.startsWith("create") || l.includes("createAudioClip"));
    // The clip starts at beat 8, at 120 BPM: A - intro at 0 s is beat 8, B - verse at 10 s is beat 28.
    expect(creates.slice(-2)).toEqual(["createCuePoint 8@outside", "createCuePoint 28@outside"]);
    expect(creates.slice(0, -2).some((l) => l.startsWith("createCuePoint"))).toBe(false);
    expect(f.log.filter((l) => /^set cue\d/.test(l))).toEqual(["set cue1.name=A - intro@tx", "set cue2.name=B - verse@tx"]);
    expect(f.log.some((l) => l.includes("clearClipsInRange") || l.includes("source"))).toBe(false);
    expect(r.steps).toBe(4 + 5 + 2 + 1);
  });

  it("Arrangement: the locators carry each section's key with Key in names, as Apply's do; none with it off", async () => {
    const profile = withHarmonics(KK_MINOR).map((_, i, p) => p[(i - 2 + 12) % 12] / 10); // D minor throughout
    const harmony: Harmony = { source: "stems", rate: 2, chroma: Array.from({ length: SONG_SEC * 2 }, () => profile) };
    const keys = sectionKeys(harmony, SONG).map((k) => (k?.sure ? keyShort(k) : null));
    expect(keys.every((k) => k !== null)).toBe(true);
    const f = await setup({ seconds: SONG_SEC, newTrackSelected: true });
    await f.send(allStems({ harmony }));
    expect(f.log.filter((l) => /^set cue\d/.test(l))).toEqual([`set cue1.name=A - intro · ${keys[0]}@tx`, `set cue2.name=B - verse · ${keys[1]}@tx`]);
    const g = await setup({ seconds: SONG_SEC, newTrackSelected: true });
    await g.send(allStems({ harmony, keyInNames: false }));
    expect(g.log.filter((l) => /^set cue\d/.test(l))).toEqual(["set cue1.name=A - intro@tx", "set cue2.name=B - verse@tx"]);
  });

  it("Arrangement: a section past the clip's end gets its locator at the clip's end, as Apply's Locators do", async () => {
    const f = await setup({ seconds: 12, newTrackSelected: true }); // the clip is 24 beats long: it ends at beat 32
    await f.send(allStems());
    expect(f.log.filter((l) => l.startsWith("createCuePoint"))).toEqual(["createCuePoint 8@outside", "createCuePoint 28@outside"]);
    const g = await setup({ seconds: 8, newTrackSelected: true }); // 16 beats: B - verse at 10 s is past its end, beat 24
    await g.send(allStems());
    expect(g.log.filter((l) => l.startsWith("createCuePoint"))).toEqual(["createCuePoint 8@outside", "createCuePoint 24@outside"]);
  });

  it("Session: no locators (the scene names carry the sections)", async () => {
    const f = await setup({ view: "session", seconds: SONG_SEC, newTrackSelected: true });
    await f.send(allStems());
    expect(f.log.some((l) => l.includes("CuePoint") || l.startsWith("set cue"))).toBe(false);
  });

  it("a locator that fails raises SendError counting the tracks, clips and locators made, and the message says so", async () => {
    const f = await setup({ seconds: SONG_SEC, newTrackSelected: true, failCueAt: 2 });
    const e = (await f.send(allStems()).catch((x) => x)) as SendError;
    expect(e).toBeInstanceOf(SendError);
    expect(f.log).toContain("set cue1.name=A - intro@tx"); // what was made is still named
    expect(e.steps).toBe(4 + 5 + 1 + 1);
    expect(e.made).toBe("4 new audio tracks, 5 clips and a locator");
    expect(sendFailedMessage(e)).toBe(
      "Song Sections couldn't finish sending the stems. It made 4 new audio tracks, 5 clips and a locator; use Edit › Undo 11 times to remove them.",
    );
    const g = await setup({ seconds: SONG_SEC, newTrackSelected: true, failCreateAt: 1 }); // no clip, so no locator either
    const e2 = (await g.send(allStems()).catch((x) => x)) as SendError;
    expect(e2.made).toBe("4 new audio tracks");
  });

  it("the track names carry the clip key, never the drums'; the clips their slice's", async () => {
    const profile = withHarmonics(KK_MINOR).map((_, i, p) => p[(i - 2 + 12) % 12] / 10); // D minor throughout
    const harmony: Harmony = { source: "stems", rate: 2, chroma: Array.from({ length: SONG_SEC * 2 }, () => profile) };
    const key = keyShort(clipKey(harmony)!);
    const f = await setup({ seconds: SONG_SEC, newTrackSelected: true });
    await f.send(allStems({ harmony }));
    expect(f.log.filter((l) => /^set t\d\.name/.test(l))).toEqual(["set t3.name=My Song (drums)@tx", ...["bass", "vocals", "other"].map((s, k) => `set t${4 + k}.name=My Song (${s}) · ${key}@tx`)]);
    expect(f.log).toContain("set t3/clip0.name=drums 1@tx");
    expect(f.log).toContain(`set t6/clip2.name=other 1 · ${key}@tx`);
    // Session: the scene names carry the section's key, as Apply's do.
    const g = await setup({ view: "session", seconds: SONG_SEC, newTrackSelected: true });
    await g.send(allStems({ harmony }));
    expect(g.log).toContain(`set scene3.name=A - intro 1 · ${key}@tx`);
  });

  it("Review Focus 5: a Session send with 120 scenes completes, and counts a step per track, scene and clip, and the names", async () => {
    const drums = Array.from({ length: 120 }, (_, i) => ({ start: i, end: i === 119 ? 130 : i + 1, label: `drums ${(i % 3) + 1}`, color: i % 3 }));
    const stems = { drums, bass: [], vocals: [], other: [] };
    const sections = [{ start: 0, end: 130, label: "A - intro", color: 1 }];
    expect(sceneStarts(stems, sections, 130)).toHaveLength(120);
    const f = await setup({ view: "session", seconds: 130 });
    const r = await f.send(allStems({ sections, stems, stemPaths: paths130, durationSec: 130 }));
    const clips = f.log.filter((l) => l.includes("createAudioClip")).length;
    expect(f.log.filter((l) => l.startsWith("createScene"))).toHaveLength(120);
    expect(clips).toBe(120);
    expect(f.log).toContain("set scene122.name=A - intro 120@tx");
    expect(r.steps).toBe(4 + 120 + clips + 1);
  });

  it("a failure after 2 tracks raises SendError: the two tracks are named, top to bottom, and counted, and the message says so", async () => {
    const f = await setup({ view: "session", seconds: SONG_SEC, failTrackAt: 3 }); // each new track right after the source
    const e = (await f.send(allStems()).catch((x) => x)) as SendError;
    expect(e).toBeInstanceOf(SendError);
    expect(f.log.filter((l) => l.startsWith("create"))).toEqual(["createAudioTrack@outside", "createAudioTrack@outside"]);
    // t4 went in above t3, so it is the drums.
    expect(f.log.filter((l) => l.endsWith("@tx"))).toEqual(["set t4.name=My Song (drums)@tx", "set t3.name=My Song (bass)@tx"]);
    // The brief says steps === 2. The tracks are 2; as every send does (README "Known limits"), the transaction that
    // names them is counted too, so Undo is pressed 3 times. See the task report.
    expect(e.steps).toBe(2 + 1);
    expect(e.made).toBe("2 new audio tracks");
    expect(sendFailedMessage(e)).toBe("Song Sections couldn't finish sending the stems. It made 2 new audio tracks; use Edit › Undo 3 times to remove them.");
    expect(await readdir(f.temp)).toEqual([]);
  });

  it("Task 8 review: a failure before Live is touched says the stems were not sent", async () => {
    const f = await setup({ view: "session", seconds: SONG_SEC });
    const e = (await f.send(allStems({ stemPaths: { ...paths16, drums: join(root, "missing.wav") } })).catch((x) => x)) as SendError;
    expect(e.steps).toBe(0);
    expect(sendFailedMessage(e)).toBe("Song Sections couldn't send the stems. Your Set was not changed.");
  });

  it("Task 8 review I1: the stems go to the new tracks in their order in the Set, drums on top, whatever order Live put them in", async () => {
    for (const view of ["arrangement", "session"] as const) {
      const f = await setup({ view, seconds: SONG_SEC }); // each new track right after the source: reversed
      await f.send(allStems());
      const set = f.tracks as Array<{ id?: string; name?: string; arrangementClips?: Array<{ name?: string }> }>;
      const fresh = set.slice(2, 6);
      expect(fresh.map((t) => t.id ?? "")).toEqual(["t6", "t5", "t4", "t3"]); // made t3 first, but it is lowest
      expect(fresh.map((t) => t.name)).toEqual(STEM_NAMES.map((s) => `My Song (${s})`));
      if (view === "arrangement") expect(fresh.map((t) => t.arrangementClips!.map((c) => c.name))).toEqual([["drums 1", "drums 2"], [], [], ["other 1", "other 2", "other 1"]]);
      else expect(f.log.filter((l) => l.includes("createAudioClip")).map((l) => l.split(".createAudioClip")[0].slice(0, 7))).toEqual([...new Array(5).fill("slot t6"), ...new Array(5).fill("slot t3")]);
    }
  });

  it("Task 8 review: a stem plays in every scene its slices reach into, named by the slice that fills most of it", async () => {
    // Drums 0–8.5 then a rest; the other's cut at 8 makes the scenes [0, 8) and [8, 16), the drums' 8.5 is merged.
    const stems = {
      drums: [{ start: 0, end: 8.5, label: "drums 1", color: 1 }],
      bass: [],
      vocals: [],
      other: [{ start: 0, end: 8, label: "other 1", color: 2 }, { start: 8, end: 16, label: "other 2", color: 3 }],
    };
    const sections = [{ start: 0, end: 16, label: "A - intro", color: 1 }];
    expect(sceneStarts(stems, sections, SONG_SEC)).toEqual([0, 8]);
    const f = await setup({ view: "session", seconds: SONG_SEC, newTrackSelected: true });
    await f.send(allStems({ sections, stems }));
    // The drums' audio from 8 s to 8.5 s is played: scene 2 has a drums clip from 8 s.
    expect(f.log.filter((l) => l.startsWith("slot t3"))).toEqual([
      "slot t3[3].createAudioClip My Song - drums.wav warped=false markers=0..8 loop=0..8 looping=false@outside",
      `slot t3[4].createAudioClip My Song - drums.wav warped=false markers=8..${file16} loop=8..${file16} looping=false@outside`,
    ]);
    expect(f.log).toContain("set t3[4]/clip.name=drums 1@tx");
    // Two slices in one scene: the one with the most of it names the clip.
    const g = await setup({ view: "session", seconds: SONG_SEC, newTrackSelected: true });
    await g.send(allStems({ sections, stems: { ...stems, drums: [stems.drums[0], { start: 8.5, end: 16, label: "drums 2", color: 4 }] } }));
    expect(g.log).toContain("set t3[3]/clip.name=drums 1@tx");
    expect(g.log).toContain("set t3[4]/clip.name=drums 2@tx");
  });

  it("Task 8 review: sceneStarts keeps a section's start over a stem cut less than a second from it, so the scene is named for that section", async () => {
    const stems = { ...STEMS, drums: [], other: [{ start: 0, end: 9.5, label: "other 1", color: 1 }, { start: 9.5, end: 16, label: "other 2", color: 2 }] };
    expect(sceneStarts(stems, SONG, SONG_SEC)).toEqual([0, 10]);
    const f = await setup({ view: "session", seconds: SONG_SEC, newTrackSelected: true });
    await f.send(allStems({ stems }));
    expect(f.log.filter((l) => /^set scene\d+\.name/.test(l))).toEqual(["set scene3.name=A - intro 1@tx", "set scene4.name=B - verse 1@tx"]);
  });

  it("Task 8 review: a stem that rests until mid-song has empty slots until its first slice", async () => {
    const f = await setup({ view: "session", seconds: SONG_SEC, newTrackSelected: true });
    await f.send(allStems({ stems: { ...STEMS, vocals: [{ start: 12, end: 16, label: "vocals 1", color: 5 }] } }));
    // Scenes 3..7 start at 0, 4, 8, 10 and 12 s; the vocals (t5) come in at 12 s.
    expect(f.log.filter((l) => l.startsWith("slot t5"))).toEqual([`slot t5[7].createAudioClip My Song - vocals.wav warped=false markers=12..${file16} loop=12..${file16} looping=false@outside`]);
    expect(f.log).toContain("set t5[7]/clip.name=vocals 1@tx");
  });
});

describe("names with keys (v2)", () => {
  // A harmony for SECTIONS: C major for the first 5 s, D minor from 5 s to 12.5 s, then silence (no key).
  const profile = (minor: boolean, tonic: number) => {
    const p = withHarmonics(minor ? KK_MINOR : KK_MAJOR);
    return Array.from({ length: 12 }, (_, i) => p[(i - tonic + 12) % 12] / 10);
  };
  const rows = Array.from({ length: SECONDS * 2 }, (_, f) => (f < 10 ? profile(false, 0) : f < 25 ? profile(true, 2) : new Array(12).fill(0)));
  const harmony: Harmony = { source: "stems", rate: 2, chroma: rows };
  const clip = keyShort(clipKey(harmony)!);
  const fileClip = clip;
  const names = (log: string[]) => log.filter((l) => l.startsWith("set ") && l.includes(".name="));

  it("the keys are the dialog's: each section's, and the clip's; none for the drums, with the toggle off, or without a harmony", () => {
    const k = nameKeys({ source: "bass", sections: SECTIONS, harmony });
    expect(k.sections.map((x) => (x ? keyShort(x) : null))).toEqual(["C", "Dm", null]);
    expect(k.clip).toEqual(clipKey(harmony));
    for (const req of [{ source: "drums" as const, harmony }, { source: "mix" as const, harmony, keyInNames: false }, { source: "mix" as const, harmony: null }]) {
      expect(nameKeys({ ...req, sections: SECTIONS })).toEqual({ sections: [null, null, null], clip: null });
    }
  });

  it("Simpler: `<label> (<stem>) · Dm`, and the file `… - Dm [hash].wav`", async () => {
    const f = await setup();
    await f.send({ target: "simpler", source: "vocals", index: 1, harmony });
    expect(names(f.log)).toEqual(["set t3.name=B (vocals) · Dm@tx"]);
    expect(f.loaded.map(nm)).toEqual(["My Song - B - vocals - Dm.wav"]);
    expect(basename(f.loaded[0])).toMatch(/^My Song - B - vocals - Dm \[[0-9a-f]{6}\]\.wav$/);
  });

  it("drums get no key, and neither does anything with Key in names off", async () => {
    const f = await setup();
    await f.send({ target: "simpler", source: "drums", index: 1, harmony });
    await f.send({ target: "simpler", source: "mix", index: 1, harmony, keyInNames: false });
    expect(names(f.log)).toEqual(["set t3.name=B (drums)@tx", "set t4.name=B (mix)@tx"]);
    expect(f.loaded.map(nm)).toEqual(["My Song - B - drums.wav", "My Song - B - mix.wav"]);
  });

  it("Drum Rack: the track carries the clip key, each pad's file its section's (none for a section without one)", async () => {
    const f = await setup();
    await f.send({ target: "drumRack", source: "bass", harmony });
    expect(f.loaded.map(nm)).toEqual(["My Song - A - intro - bass - C.wav", "My Song - B - bass - Dm.wav", "My Song - A - intro - bass.wav"]);
    expect(names(f.log)).toContain(`set t3.name=My Song (bass) sections · ${clip}@tx`);
    // The MIDI clip keeps the clip's name.
    expect(names(f.log).find((l) => l.includes("/clip"))).toMatch(/\.name=My Song@tx$/);
  });

  it("audio, one section: the track and the clip carry the section's key", async () => {
    const f = await setup();
    await f.send({ target: "audioSection", source: "other", index: 0, harmony });
    expect(names(f.log)).toEqual(["set t3.name=A - intro (other) · C@tx", "set t3/clip0.name=A - intro · C@tx"]);
    expect(f.loaded.map(nm)).toEqual(["My Song - A - intro - other - C.wav"]);
  });

  it("audio, the whole source: the track and file carry the clip key, each piece its section's (Arrangement)", async () => {
    const f = await setup();
    await f.send({ target: "audioWhole", source: "mix", index: 0, harmony });
    expect([...new Set(f.loaded.map(nm))]).toEqual([`My Song - mix - ${fileClip}.wav`]); // one file, a clip per section
    expect(names(f.log)).toEqual([
      `set t3.name=My Song (mix) · ${clip}@tx`,
      "set t3/clip0.name=A - intro · C@tx",
      "set t3/clip1.name=B · Dm@tx",
      "set t3/clip2.name=A - intro@tx",
    ]);
  });

  it("Plan 6: a lane's whole-stem clips carry their slice's key when it is sure; the drums never do", async () => {
    // Silence (no key) for the first 5 s, then D minor.
    const late: Harmony = { source: "stems", rate: 2, chroma: Array.from({ length: SECONDS * 2 }, (_, f) => (f < 10 ? new Array(12).fill(0) : profile(true, 2))) };
    const slices = (stem: string) => [
      { start: 0, end: 4, label: `${stem} 1`, color: 1 },
      { start: 6, end: 10, label: `${stem} 2`, color: 2 },
    ];
    const f = await setup();
    await f.send({ target: "audioWhole", source: "other", unit: "patterns", index: 0, sections: slices("other"), durationSec: SECONDS, harmony: late });
    await f.send({ target: "audioWhole", source: "drums", unit: "patterns", index: 0, sections: slices("drums"), durationSec: SECONDS, harmony: late });
    expect(names(f.log).filter((l) => l.includes("/clip"))).toEqual([
      "set t3/clip0.name=other 1@tx",
      "set t3/clip1.name=other 2 · Dm@tx",
      "set t4/clip2.name=drums 1@tx",
      "set t4/clip3.name=drums 2@tx",
    ]);
  });

  it("audio, the whole source, in Session: the clip is named as the track", async () => {
    const f = await setup({ view: "session" });
    await f.send({ target: "audioWhole", source: "vocals", index: 0, harmony });
    expect(names(f.log)).toEqual([`set t3.name=My Song (vocals) · ${clip}@tx`, `set t3[2]/clip.name=My Song (vocals) · ${clip}@tx`]);
  });

  it("a key it is not sure of goes into no name at all: not the track's, the clip's or the file's", async () => {
    // C major with almost as much G major: C, and not sure.
    const mixed = profile(false, 0).map((x, i) => x + 0.9 * profile(false, 7)[i]);
    expect(estimateKey(mixed)!.sure).toBe(false);
    const unsure: Harmony = { source: "mix", rate: 2, chroma: Array.from({ length: SECONDS * 2 }, () => mixed) };
    const f = await setup();
    await f.send({ target: "audioSection", source: "mix", index: 1, harmony: unsure });
    await f.send({ target: "drumRack", source: "mix", harmony: unsure });
    expect(names(f.log).filter((l) => !l.includes("/clip") || l.includes("t3/"))).toEqual(["set t3.name=B (mix)@tx", "set t3/clip0.name=B@tx", "set t4.name=My Song (mix) sections@tx"]);
    expect(f.loaded.map(nm)).toEqual(["My Song - B - mix.wav", "My Song - A - intro - mix.wav", "My Song - B - mix.wav", "My Song - A - intro - mix.wav"]);
  });
});
