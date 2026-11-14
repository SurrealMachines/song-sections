// A temp file that more than one piece of work reads (fb2 review C1: Live's render is read by the run that made it and
// by the background Structure analysis that run started, and either may end first). Each user takes its own
// reference; the file is removed when the last one is let go, and never before.

export interface SharedFile {
  readonly path: string;
  /** Takes a reference. The returned function lets it go; calling it again does nothing. */
  retain(): () => Promise<void>;
}

/** `remove` is called once, when the last reference is let go; it must not throw. */
export function sharedFile(path: string, remove: (path: string) => Promise<void>): SharedFile {
  let users = 0;
  let removed = false;
  return {
    path,
    retain() {
      if (removed) throw new Error(`sharedFile: ${path} was already removed`);
      users++;
      let held = true;
      return async () => {
        if (!held) return;
        held = false;
        if (--users > 0) return;
        removed = true;
        await remove(path);
      };
    },
  };
}
