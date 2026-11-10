import { RING_RADIUS, TABLE_HALF_X, TABLE_HALF_Z } from '../game/constants';

export function makeCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return { canvas, g: canvas.getContext('2d')! };
}

/** Deterministic noise so the table looks the same on every load. */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

function paintWood(g: CanvasRenderingContext2D, w: number, h: number, seed: number) {
  const rnd = seeded(seed);
  const planks = 5;
  const plankH = h / planks;
  for (let p = 0; p < planks; p++) {
    const y = p * plankH;
    const tone = 0.92 + rnd() * 0.12;
    g.fillStyle = `rgb(${196 * tone}, ${146 * tone}, ${90 * tone})`;
    g.fillRect(0, y, w, plankH);

    // Long wavy grain lines along the plank.
    for (let i = 0; i < 90; i++) {
      const gy = y + rnd() * plankH;
      const amp = 2 + rnd() * 9;
      const freq = 0.002 + rnd() * 0.004;
      const phase = rnd() * 10;
      g.strokeStyle = `rgba(${84 + rnd() * 40}, ${48 + rnd() * 26}, ${20 + rnd() * 12}, ${0.05 + rnd() * 0.15})`;
      g.lineWidth = 0.6 + rnd() * 2;
      g.beginPath();
      for (let x = 0; x <= w; x += 16) {
        const yy = gy + Math.sin(x * freq + phase) * amp;
        if (x === 0) g.moveTo(x, yy);
        else g.lineTo(x, yy);
      }
      g.stroke();
    }

    // A knot or two: concentric ellipses.
    if (rnd() < 0.7) {
      const kx = rnd() * w;
      const ky = y + plankH * (0.3 + rnd() * 0.4);
      for (let r = 34; r > 2; r -= 5) {
        g.strokeStyle = `rgba(74, 40, 16, ${0.1 + (34 - r) / 130})`;
        g.lineWidth = 1.5;
        g.beginPath();
        g.ellipse(kx, ky, r * 2, r * 0.75, 0, 0, Math.PI * 2);
        g.stroke();
      }
    }

    // Gap between the planks.
    g.fillStyle = 'rgba(52, 28, 12, 0.5)';
    g.fillRect(0, y - 1, w, 2.5);
  }
}

/** Oak planks with the sumo ring and start lines painted on. */
export function tableTexture() {
  const w = 2048;
  const h = Math.round((w * TABLE_HALF_Z) / TABLE_HALF_X);
  const { canvas, g } = makeCanvas(w, h);
  paintWood(g, w, h, 7);

  const scale = w / (TABLE_HALF_X * 2);
  const cx = w / 2;
  const cy = h / 2;

  // Darken towards the edge: it reads as "danger" and grounds the scene.
  const vignette = g.createRadialGradient(cx, cy, h * 0.35, cx, cy, w * 0.62);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(40,18,4,0.42)');
  g.fillStyle = vignette;
  g.fillRect(0, 0, w, h);

  g.strokeStyle = 'rgba(248, 246, 238, 0.9)';
  g.lineWidth = 15;
  g.beginPath();
  g.arc(cx, cy, RING_RADIUS * scale, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 4;
  g.beginPath();
  g.arc(cx, cy, RING_RADIUS * scale - 22, 0, Math.PI * 2);
  g.stroke();

  // Shikiri-sen, the two lines wrestlers face off behind.
  g.fillStyle = 'rgba(248, 246, 238, 0.85)';
  for (const side of [-1, 1]) {
    g.fillRect(cx + side * 0.42 * scale - 7, cy - 0.3 * scale, 14, 0.6 * scale);
  }

  // Hazard ticks along the table edge.
  g.fillStyle = 'rgba(245, 158, 11, 0.75)';
  const tick = 0.1 * scale;
  for (let x = tick; x < w; x += tick * 3) {
    g.fillRect(x, 0, tick, 11);
    g.fillRect(x, h - 11, tick, 11);
  }
  for (let y = tick; y < h; y += tick * 3) {
    g.fillRect(0, y, 11, tick);
    g.fillRect(w - 11, y, 11, tick);
  }
  return canvas;
}

export function woodSideTexture() {
  const { canvas, g } = makeCanvas(512, 128);
  paintWood(g, 512, 128, 41);
  g.fillStyle = 'rgba(40, 20, 8, 0.35)';
  g.fillRect(0, 0, 512, 128);
  return canvas;
}

/** A clear plastic ruler: length marks and numbers along both edges. */
export function rulerTexture() {
  const w = 1024;
  const h = 256;
  const { canvas, g } = makeCanvas(w, h);
  g.fillStyle = '#FACC15';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#EAB308';
  g.fillRect(0, h * 0.42, w, h * 0.16);
  g.fillStyle = '#1F2937';
  g.strokeStyle = '#1F2937';
  g.font = '700 28px "JetBrains Mono", monospace';
  g.textBaseline = 'top';
  const step = w / 100;
  for (let i = 0; i <= 100; i++) {
    const x = i * step;
    const len = i % 10 === 0 ? 62 : i % 5 === 0 ? 44 : 26;
    g.lineWidth = i % 10 === 0 ? 3 : 1.6;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, len);
    g.moveTo(x, h);
    g.lineTo(x, h - len);
    g.stroke();
    if (i % 10 === 0 && i > 0 && i < 100) {
      g.fillText(String(i / 10), x + 5, 66);
    }
  }
  return canvas;
}

export function skyTexture() {
  const { canvas, g } = makeCanvas(32, 512);
  const gradient = g.createLinearGradient(0, 0, 0, 512);
  gradient.addColorStop(0, '#0B1220');
  gradient.addColorStop(0.42, '#0F172A');
  gradient.addColorStop(0.53, '#3A2A22');
  gradient.addColorStop(0.62, '#20202A');
  gradient.addColorStop(1, '#0F172A');
  g.fillStyle = gradient;
  g.fillRect(0, 0, 32, 512);
  return canvas;
}

export function floorTexture() {
  const { canvas, g } = makeCanvas(1024, 1024);
  g.fillStyle = '#1B2333';
  g.fillRect(0, 0, 1024, 1024);
  const glow = g.createRadialGradient(512, 512, 40, 512, 512, 512);
  glow.addColorStop(0, 'rgba(214, 150, 80, 0.32)');
  glow.addColorStop(0.55, 'rgba(120, 88, 60, 0.12)');
  glow.addColorStop(1, 'rgba(0,0,0,0.25)');
  g.fillStyle = glow;
  g.fillRect(0, 0, 1024, 1024);
  return canvas;
}

/** Round soft sprite for sparks. */
export function sparkTexture() {
  const { canvas, g } = makeCanvas(64, 64);
  const gradient = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.3, 'rgba(255,255,255,0.75)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gradient;
  g.fillRect(0, 0, 64, 64);
  return canvas;
}
