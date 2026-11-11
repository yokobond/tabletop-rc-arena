import { TABLE_HALF_X } from '../game/constants';

/** Which marker of the dictionary carries the arena. Every device looks for the same one. */
export const MARKER_DICTIONARY = 'ARUCO_MIP_36h12';
export const MARKER_ID = 12;

/** The table is this many marker widths wide (the marker's black square, without its white margin). */
export const AR_SIZES = [4, 6, 9] as const;
export type ArSize = (typeof AR_SIZES)[number];

/** Edge of the marker's black square in simulation units. */
export const markerSize = (size: ArSize) => (TABLE_HALF_X * 2) / size;

/** The marker library is only fetched once somebody turns AR on or opens the marker sheet. */
export async function loadAruco() {
  const [aruco, posit] = await Promise.all([import('js-aruco2'), import('js-aruco2/src/posit1.js')]);
  return { AR: aruco.default.AR, POS: posit.default.POS };
}

/** The marker to print, as an SVG string: the black square is 8 of its 10 units wide. */
export async function markerSvg() {
  const { AR } = await loadAruco();
  return new AR.Dictionary(MARKER_DICTIONARY).generateSVG(MARKER_ID);
}
