import { encodeQrText, type QrCode } from "./qr-encode.ts";

export const QR_BORDER = 4;

export function qrCodeSvg(qr: QrCode, border: number = QR_BORDER): string {
  if (!Number.isInteger(border) || border < 0 || border > 16) throw new RangeError("QR: border 0–16 modules");
  const n = qr.size + border * 2;
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) if (qr.modules[y]![x]) parts.push(`M${x + border},${y + border}h1v1h-1z`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR code">`
    + `<rect width="${n}" height="${n}" fill="#ffffff"/><path d="${parts.join("")}" fill="#000000"/></svg>`;
}

export function qrSvg(text: string): string {
  return qrCodeSvg(encodeQrText(text, { ecl: "M" }));
}
