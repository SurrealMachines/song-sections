export function secondsToBeats(sec: number, tempo: number): number {
  return (sec * tempo) / 60;
}

/**
 * Clip markers are in beats for warped clips and in seconds for unwarped ones
 * (finding R10), so convert a duration in seconds to marker units.
 */
export function secondsToMarkerDelta(sec: number, warped: boolean, tempo: number): number {
  return warped ? secondsToBeats(sec, tempo) : sec;
}
