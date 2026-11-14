// jsdom ships no types and @types/jsdom is not installed; this is the slice timeline.dom.test.ts uses.
declare module "jsdom" {
  export interface ConstructorOptions {
    url?: string;
    runScripts?: "dangerously" | "outside-only";
    pretendToBeVisual?: boolean;
    beforeParse?(window: Window & typeof globalThis): void;
  }
  export class JSDOM {
    constructor(html?: string, options?: ConstructorOptions);
    readonly window: Window & typeof globalThis;
  }
}
