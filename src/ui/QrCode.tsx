import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/** Quiet zone around the code, in modules. The spec asks for four. */
const MARGIN = 4;

/** `text` as a QR code: dark modules on a white card, so it scans on the dark UI too. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += `M${col + MARGIN} ${row + MARGIN}h1v1h-1z`;
      }
    }
    return { size: count + MARGIN * 2, path: d };
  }, [text]);

  return (
    <svg className="qr-code" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
