declare module 'js-aruco2' {
  interface Marker {
    id: number;
    corners: { x: number; y: number }[];
  }
  class Dictionary {
    constructor(name: string);
    codeList: string[];
    markSize: number;
    generateSVG(id: number): string;
  }
  class Detector {
    constructor(config?: { dictionaryName?: string; maxHammingDistance?: number });
    detect(image: { width: number; height: number; data: ArrayLike<number> }): Marker[];
  }
  const aruco: { AR: { Dictionary: typeof Dictionary; Detector: typeof Detector } };
  export default aruco;
}

declare module 'js-aruco2/src/posit1.js' {
  class Posit {
    constructor(modelSize: number, focalLength: number);
    pose(points: { x: number; y: number }[]): {
      bestError: number;
      bestRotation: number[][];
      bestTranslation: number[];
      alternativeError: number;
      alternativeRotation: number[][];
      alternativeTranslation: number[];
    };
  }
  const posit: { POS: { Posit: typeof Posit } };
  export default posit;
}
