export type Rgb = number; // 0xRRGGBB
export interface Section {
  start: number;
  end: number;
  label: string;
  color: Rgb;
} // seconds from clip audio start
export type ColorMode = "gradient" | "uniform";
export type ArrangementOutput = "split" | "locators" | "both";
export type View = "arrangement" | "session";
