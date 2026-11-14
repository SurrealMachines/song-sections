declare module "*.html" {
  const content: string;
  export default content;
}

declare module "*.css";

/** True in `npm run build:dev` bundles, false in production (set by build.ts). */
declare const __DEV__: boolean;
