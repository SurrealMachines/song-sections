# Song Sections

An Ableton Live extension that finds the sections of a song in an audio clip and
writes them back to the Live Set. Free and open source (MIT), by Matt Jackson
([Surreal Machines](https://surrealmachines.com)). Independent: not made or supported by Ableton.

- **Just want to use it?** Download the `.ablx` from [the Song Sections page](https://www.surrealmachines.com/song-sections/) or
  [Releases](https://github.com/SurrealMachines/song-sections/releases), and follow its Install.txt.
  It needs Ableton Live 12 Suite, public beta 12.4.5 or later, on an Apple Silicon Mac or a Windows PC.
- **Feedback, bugs and ideas:** [the feedback form](https://docs.google.com/forms/d/e/1FAIpQLScd59zbcMcl8Dl9BZDT43lXCc9pzAbiyHYqAKSDAzRwxMbHxg/viewform), or open an issue here.
- **Want to change the code?** See [Building from source](#building-from-source).

Right-click an audio clip and choose **Find Sections…**. The extension renders the
clip, analyzes it for points where the music changes (DSP novelty analysis, engine
`cue-dsp-1`), and opens a preview dialog. In the dialog you can:

- move the granularity slider to get fewer or more cue points;
- drag cue points to adjust them, and play back the rendered audio;
- color sections with a gradient or all in the clip's color;
- in Arrangement view, choose the output: **split clip**, **locators**, or **both**.

**Apply** writes the sections to Live and **Cancel** leaves the Set untouched:

- **Arrangement:** the clip is split natively, meant to match Cmd+E, into one piece per
  section. Each piece still references the whole file and keeps its loop values and warp markers.
  Gain, fades and envelopes are expected to carry over too, but this is not yet
  verified in Live. Each piece is then named and colored, and/or a named locator
  is placed at each section start.
- **Session:** a new scene is inserted for each section directly below the
  original clip's scene, pushing later scenes down. Each new scene holds that
  section's slice in the same track. Slices are rebuilt from the file, so custom
  warp markers and clip settings reset. The original clip is not changed.

**Sending sections (v2).** Right-click a section band to send that section of the mix (the clip's own audio), or,
in Structure, a stem lane cell to send that stem. The menu offers:

- **Send to Simpler:** a new MIDI track with a Simpler holding that section, named `<label> (<stem>)`.
- **Send to new audio track:** a new audio track with that section as one unwarped clip, at the section's place
  in Arrangement or in the clip's scene row in Session.
- **Send all <stem> sections to Drum Rack:** a new MIDI track, `<clip name> (<stem>) sections`, with a Drum Rack
  holding one pad per section from C1 up in time order (repeats get their own pad, at most 92: C1 to G8), and a
  MIDI clip named after the clip that plays the pads in order, as Live's Slice to New MIDI Track does.
- **Send all <stem> to new audio track:** a new audio track, `<clip name> (<stem>)`, with the whole stem as one
  unwarped clip per section, each at its section's place and named and colored like it (Arrangement; the stem is not
  split, because Live warps the pieces of a split unwarped clip), or as one clip in the clip's scene row (Session).

A send closes the dialog like Apply and sends the sections as edited there. Each section is cut from the audio
sample-accurately as a WAV named `<clip name> - <label> - <stem> [abc123].wav` (the end is a short hash of the
audio, so sends never reuse a name) and copied into the Live project before it is loaded. When Live does not copy it
(perhaps an unsaved Set), it is kept in the extension's storage folder (`sent/`, never pruned) and the dialog says to
use Collect All and Save. Stems can be sent only once Structure has kept them. The SDK cannot color tracks or Drum Rack pads, nor
name pads, so only clips are colored; it puts a new track after the selected track (or last), with no way to move it.

**Keys (v2).** The dialog shows the musical key of the clip in its header (for example **Key: D minor**) and of each
section on its band, after the length when the band has room, or in its tooltip (and in the stem lanes' tooltips, but
the drums'). It follows every edit at once. A trailing **?** means the detector is not sure: another key, other than
the relative one, fits almost as well. While Live's Scale Mode is on, the Set's scale is shown beside the clip key, for
comparison; the SDK cannot set a clip's key, so the key goes only into the dialog and the names.

- Where the key is heard: in Structure with kept stems, the bass, other and vocals stems (no drums); in Cue, or without
  stems, the clip's own audio. So the two modes can disagree slightly.
- How: a 12-bin chroma (0.37 s window, whitened, 2 frames a second, with the clip brought to a reference level and its
  tuning estimated within ±50 cents) is computed once per clip and cached in `cache/harmony-2/` beside the analyses.
  Existing analysis caches stay valid; an older one gets its harmony the first time it is opened, without the models.
  The stems' entry is named after the Structure engine that separated them. A section's key is the best of the 24
  Krumhansl–Kessler major and minor profiles, with each degree's overtones added in (Gómez 2006), correlated with the
  section's summed chroma. It is sure when it beats every key but its relative by 0.1, fits its profile at 0.6 or
  better, and the section is at least 4 s long (a bar or two is a chord, not a key).
- Names: a send from the mix, bass, other or vocals appends the key: `B (bass) · Dm` for Simpler and audio tracks and
  clips, `<clip name> (<stem>) sections · Dm` (the clip key) for the Drum Rack track, `… - Dm [abc123].wav` for the
  files; the pieces of a whole-stem send are named `<label> · Dm`. Only a sure key goes into a name: one shown with `?` in
  the dialog is left out of every track, clip and file name. Drum sends, and Apply, get no key. **Key in names** in
  the send menu turns it off; it is remembered.
- `npx tsx scripts/key-report.ts <storage dir>` prints the keys of every cached Structure analysis with kept stems.

The dialog has two modes, picked with the tabs at the top: **Cue points** (the fast
DSP analysis above) and **Structure**, which separates the clip into stems and names
each section by what repeats and what it is (for example `A′ - chorus`). Structure
takes about a minute for a 3-minute song on an Apple Silicon Mac. The first time you
click **Structure**, the tab asks to download its models (see "Structure models" below).

Find Sections… opens in Cue points, because that analysis takes seconds. The one
exception: if the last sections you applied came from Structure and this clip has
been analyzed for Structure before, it opens straight in Structure. Otherwise the
Structure analysis starts in the background as soon as the Cue dialog is up, whatever
mode you used last (after a Structure Apply the tab is also highlighted as the
suggestion). It never downloads the models on its own. The tab shows its
progress (for example **Structure 37%**), and Live stays usable meanwhile.

- Click **Structure** while it is still running and a progress dialog shows the rest
  of the same analysis; canceling that dialog only returns to Cue points, and the
  analysis carries on.
- Click it once the analysis is done and Structure opens at once.
- Apply or Cancel in Cue points does not stop it: it finishes and is cached, so next
  time the Structure tab of that clip opens instantly. Find Sections… on the same clip
  while it is still running picks it up; on another clip it stops it first.
- It only starts when the models are already installed and the clip is short enough
  to analyze without asking (about 8 minutes); otherwise Structure is analyzed when
  you click the tab, as before. If it fails, nothing is shown until you click the tab.
- While it runs in the background it gives way: it pauses whenever Song Sections is
  doing something else (applying sections, rendering the next clip, answering the
  dialog), so it takes somewhat longer than it does under its progress dialog. The one
  thing it cannot interrupt is a single model run, which is about 1 second while it
  separates the stems and about 3 seconds while it finds the sections; a click on
  Apply then waits for that run to end.

Analysis results are cached in the extension's storage directory, keyed on a hash
of the rendered audio. When you reopen the same clip, the analysis step is skipped.
The clip is still rendered and prepared each time, because the dialog needs the
preview audio and waveform.

**Patterns (Structure).** Under the sections, Structure shows one lane per
kept stem (drums, bass, vocals, other), cut into the patterns each plays: slices of one bar or more, numbered in the
order they first appear. A slice that comes back is given its number again (`1, 2, 1`), one that comes back with a
note or a hit changed, or transposed, is the number with a prime (`1′`), and a silent stretch is a rest, shown without
a number. The lanes are computed from per-bar features of each source (engine `patterns-1`) and come with the analysis; an older analysis gets
them the first time it is opened, inside **Analyzing…**, which shows no progress for that part.

- **Patterns slider** (Fewer to More): how finely the lanes are cut. It stops only at the levels that change something
  for this clip, so it has as many positions as there are different cuts, and it is disabled when nothing splits.
  Moving it never touches the cuts you have edited.
- **Lane gestures:** click a cut to select it; **←/→** nudge the selected cut a beat (**Shift**: a bar) and play it
  from there; drag a cut to move it (**⌘** skips the snapping), and the lane scrolls when the drag reaches its edge;
  double-click a cell to insert a cut; **Delete**/**Backspace**, or a double-click on a cut, removes it; right-click a
  cell and click the name at the top of the menu to rename that pattern wherever it comes back, including its primed
  variants. A name already used in that lane instead moves just that cell to that pattern: `2′` on a 2 makes it alone a
  variant, `3` on a 2 makes it a 3. Primes can be typed as ′, ' or ’. Choosing the cell's own name back undoes it, and a
  number no cell uses any more closes up. A blank name (delete, then Enter) gives a section or pattern its automatic
  name back: a reassigned cell returns to its own pattern, and anything renumbered into its letter or number moves back up. The header hint ends "Right-click to send a band or lane, or rename a pattern. Double-click a slider to
  reset it."
- **Renaming letters and numbers.** Right-click a band or a pattern cell and click the name at the top of the menu (or
  double-click a band). The list of names in use is sorted by letter (or number), and each letter's last row has a
  **+**: type a letter in use there (`C`) and the old C's and every later letter move up one, so the new C is free;
  type anything else (`C′ - solo`) and it is just the name. No rename leaves a letter or number unused: the later ones
  move down to close the gap. Colors follow the letters and numbers.
- **Coloring a name.** A band's right-click menu has swatches under its name: the five shades Live has of its
  letter's color, then one of every other color. A pick colors every section with that name, and stays with the name:
  rename a section to it and it takes the color, rename it away and it loses it (case, spacing and how the prime is
  typed aside), and a rename that renumbers letters takes the color along. A pattern cell's menu does the same for
  that pattern in its own lane (drums' 1 is not bass's 1). **Auto** gives the automatic color back. Only Live's own
  clip colors are offered, so Apply and the sends keep exactly what is picked. Not on a rest, and not under Clip color.
- **Defaults and reset.** A first run (no saved choices) opens Structure with Sections −0.14, Letters 0.22, Patterns on
  More, Slice by **Sections**, Colors **Soft**, Snap on to **Bars**, Show stems on, and, in Arrangement view, Output
  **Both** (Cue opens on Both too); a choice you have saved in `settings.json` wins. **Double-click** the Sections, Letters
  or Patterns slider (Cue: Granularity) to set it back to its default, as if you had dragged it there.
- **Slice by** picks what Apply cuts the clip at: **Sections** (the bands, as before), or the patterns of **Drums**,
  **Bass**, **Vocals** or **Other**. Apply cuts at Sections instead (the tab keeps your choice)
  when that source is missing from the analysis, when its lane is all rests, and when Output is **Locators**
  (locators are placed at section starts and cut nothing). With Output **Both** the clip is cut at the lane and the
  locators are still placed at the sections.
- **Apply, Arrangement:** the clip is split at the lane's cuts into pieces named `<source> <pattern>`, for example
  `drums 2′` or `bass Groove`, and colored by pattern. Arrangement cannot take audio out of a clip, so a
  rest joins the piece before it (a leading rest, the piece after it), and a last piece under 1 second merges into the
  one before it.
- **Apply, Session:** one scene per piece, named `<section> <n>`, with `n` counting across the sections that share a
  label (`A - intro 1`, `A - intro 2`, …, `B - verse 1`, …). Rests are left out, so they get no scene.
- **Lane sends:** right-click a cell of a pattern lane for the menu of Sending sections, applied to the lane's slices
  instead of the sections: `Send to Simpler` and `Send to new audio track` for the slice (shown but disabled on a
  rest), `Send all <source> patterns to Drum Rack` (one pad per pattern, from C1 up, at most 92 pads: C1 to G8, and
  the send says so when more were cut), and `Send all <source> to new audio track`.
- **Send all stems to new tracks** (last in every menu when stems are kept, and the footer's `Send to new tracks`
  button beside Apply): four new audio tracks, one per stem, in the Set's order. In Arrangement each track gets the
  stem's audio as clips at that stem's own slices, each named and colored by its pattern, and a locator goes at each
  section, as Output `Locators` places them (with the key when Key in names is on), whatever Output is set to; the
  source clip is left as it is. In Session the scenes are the union of every stem's cut points, named `<section> <n>`
  (section starts always get a scene, and win where a cut falls near one), and a stem has a clip in every scene its
  slices reach, so firing the scenes in order plays the song.

How many scenes that is: counting scene 0, the section markers and the start of every sounding slice in the four
stems' lanes, Flim (10 sections) comes to about 62 scenes at engine level 1 and 65 at levels 2 to 4; Kashmir (23
sections) to about 130, and 134 from level 2 (Session scene count; the
slider skips levels that change nothing, so its positions need not match these levels). The real send also adds the
slice ends and merges cut points within 1 s, so its count differs a little. On these stems the higher levels add
little. Expect many scenes: a Session send of all stems makes one per cut of any stem.

## Building from source

You need Node.js 24.15 or later, Ableton Live 12 Suite (public beta 12.4.5 or later) and Ableton's
Extensions SDK. The SDK is Ableton's, under its own license, so it is not in this repository:

1. Join the Live 12 beta and download the Extensions SDK from
   [ableton.com/live/extensions](https://ableton.com/en/live/extensions/)
   ([Ableton's introduction](https://ableton.com/en/blog/introducing-extensions-sdk)).
2. Copy the SDK and CLI tarballs from it into `vendor/`. `package.json` expects
   `vendor/ableton-extensions-sdk-1.0.0-beta.0.tgz` and `vendor/ableton-extensions-cli-1.0.0-beta.0.tgz`;
   with a newer SDK, change those two paths to the new file names.
3. Run `npm install`.

### Running it

Turn on Developer Mode in Live, then run:

```sh
npm start
```

`npm start` builds the extension and runs it with `extensions-cli run`. It passes
`--storage-directory .dev/storage` and `--temp-directory .dev/temp`. Without those
flags Live leaves both directories undefined, and Find Sections only shows an error.

Other scripts:

- `npm test`: unit tests (vitest).
- `npm run test:perf`: the same suite plus the wall-clock speed bounds, which are skipped in `npm test`.
- `npm run check`: svelte-check over `src/` (props and types inside `.svelte` files, which `tsc` does not see).
- `npm run build`: type-check and production build.
- `npm run dialog:preview`: open the dialog in a browser with a canned payload.
- `npm run package`: build `song-sections-<version>.ablx`, one package for Apple Silicon Macs and Windows x64.
  Install it with Developer Mode off in Live's Extensions settings.

## Structure models

Nothing is downloaded until you agree. When the models are not installed, clicking **Structure**
in the Cue points view says what will be downloaded and how big it is, with **Download** and
**Not now**. Download fetches the authors' original weights from Hugging Face, at pinned
revisions, about 95 MB in all:

- allin1 by Taejun Kim (MIT): the 8 `harmonix-fold*.pth` checkpoints of `taejunkim/allinone`;
- HT Demucs by Meta (Alexandre Défossez): `955717e8.safetensors` of `adefossez/HTDemucs`.

Each file's size and sha256 are checked; a broken download resumes. The extension then builds the
ONNX models from them, about 190 MB on disk in `<storage>/models/allin1-htdemucs-hf-v1/`, and
deletes the downloads. The package ships only the weightless ONNX graphs and a weight map
(`models/`). Every weight is byte-identical to the earlier single-file models, so analyses are the
same and existing analysis caches stay valid. The background Structure analysis never downloads.

- `tools/hfmodels/build_models.py` made `models/` from those single-file models and the checkpoints
  (run it with the onnx-spike venv's Python; it says how). It checks the rebuilt models against
  them: same graph, byte-identical weights, bit-identical ONNX Runtime outputs.
- `npm run models:dev -- <dir> [storageDir]` builds the store offline from a folder holding the 9
  checkpoints under their Hugging Face names (for example the files of both Hugging Face snapshot
  folders), as the download would.

## Known limits

- **Undo takes several steps.** Live's SDK (1.0.0-beta.0) does not group object
  creations inside `withinTransaction` into a single undo step, despite what its
  docs say. An Arrangement split takes one undo step per cut, plus one for all the
  names and colors, and one per locator. A 10-section Arrangement split with no
  locators should take 10 presses of Cmd-Z (9 cuts and 1 label step), then the
  original is fully restored. This is expected but not yet verified in Live.
  A Session split adds one undo step per created scene and clip, plus one for the
  names and colors.
- **A send takes several undo steps too:** Send to Simpler 4, Send to new audio track 3, a Drum Rack of n pads
  3n + 4, and the whole stem on a new audio track n + 2 in Arrangement (3 in Session). Not yet verified in Live.
- **The whole stem's Arrangement clips are not yet verified in Live.** Each is made unwarped with its section's file
  seconds as its markers and an explicit length, as Session slices are; that Live reads unwarped markers as seconds
  in the Arrangement too is assumed from Session. The host log says `was made unwarped, but …` for any clip that comes
  out warped, with other markers, or at another place or length.
- **Pattern applies and sends take undo steps too:** a pieces Apply as an Arrangement split (one per cut, plus 1
  for the names and colors), or in Session one per scene and clip plus 1 for the names; Send all stems one per track,
  scene, clip and locator, plus 1 for the names (in Arrangement 4 + the clips + the locators + 1; in Session 4 + the
  scenes + the clips + 1).
  A pieces Apply logs how many pieces it cut into, and a send logs its undo steps.
- **A rest in an Arrangement pattern Apply joins the piece before it** (the piece after it for a leading rest), as
  Live cannot take audio out of a clip. Session leaves rests out instead.
- **Transposition is shown as `′`.** A slice that repeats an earlier pattern a few semitones up or down gets its
  number with a prime, as a variation does; the dialog does not say which of the two it is.
- **Send all stems in Session makes plain unwarped clips**, as the other sends do, so looping one may lose its
  place.
- **A stem's Session clips in the scenes carry some rest audio:** a clip fills every scene its slices reach, so
  near-silent rest audio is played in the scenes it overlaps.
- **Analyzing a Session clip adds undo entries.** Live can only render Arrangement
  audio, so the extension puts a copy of the clip on a temporary track, renders it,
  and deletes the track. That adds a few undo entries even when you cancel. No
  temporary track is left behind.
- **Session slices of a warped clip may come out unwarped.** The SDK can read warp
  markers but cannot set them, and Live warps a clip it creates from the file on a
  grid of its own (120 BPM for a clip warped at 150). The first slice is checked:
  if Live warped it as the source is warped, every slice stays warped (looping,
  following the tempo); otherwise every slice is made unwarped, cut at the right
  place in the file through the source's warp markers, and plays at the file's own
  tempo. Arrangement splits keep the warp markers, so they do not have this limit.
  The dialog shows a note for every warped Session clip.
- **Turning Loop on for an unwarped slice warps it.** Live cannot loop an unwarped
  clip; its Loop switch turns warping on. So an unwarped slice of a warped clip is
  made warped on Live's grid first, with the slice as its region and loop, then
  switched to unwarped: Loop then warps it back onto that region rather than the
  file's start. It follows Live's grid once warped (120 BPM in the case above), so
  it may play at another speed. If Live does not keep the region when the slice is
  unwarped, the slices are made plain unwarped instead. A slice that cannot be parked
  (a refused create or unwarp) is made plain unwarped too. Slices of a Session clip
  that is itself unwarped are not parked, so Loop still loses their place. Not yet
  verified in Live.
- **Per-clip settings reset in Session.** Session slices are rebuilt from the file,
  so per-clip gain, transpose, fades and envelopes do not carry over. Arrangement
  splits keep them, which is expected but not yet verified in Live. Edit › Undo
  restores the original.
- **Looped clips that repeat are split natively.** Verified in Live on a clip
  stretched to repeat a 16-beat loop: the pieces keep the loop region, each starts
  at the correct loop phase, and the audio is continuous across the cuts.
- **Constant tempo is assumed.** Tempo automation is ignored.
- **A warped Session clip is analyzed and previewed unwarped**, from the part of
  the file its start and end markers cover, at the file's own rate. Where the clip
  is warped to a tempo other than the song's, the preview is not stretched as Live
  plays it.
- **Platform:** one package for Apple Silicon Macs (WebKit dialog host) and
  Windows x64 (WebView2): it carries ONNX Runtime for both, and each machine copies
  only its own into storage (since 1.0.7; `--ort-target` narrows the build). On a
  Windows 11 Arm VM on 7 Nov 2026 the installed package loaded under Live's sandbox,
  downloaded the models, and ran Cue and Structure with stems and pattern lanes.
  Stem audition, Send to Simpler, Send to new tracks, and Apply in Session and
  Arrangement worked there too.
  On 13 Nov 2026 the one 1.0.7 package installed there too and analyzed Flim from
  scratch, with a result identical to 1.0.4's.
  Installed packages only run with Developer Mode off in Live's Extensions settings.

## License

Song Sections is MIT-licensed: see [LICENSE](LICENSE). It builds on allin1 (MIT), HT Demucs (MIT code),
madmom, Meyda, fft.js and ONNX Runtime, whose notices are in [licenses/](licenses/) and ship in the package.
The model weights are not in this repository: the extension downloads the authors' originals from Hugging Face,
under their own terms, after asking. Ableton's Extensions SDK is under Ableton's own license and is not included.
