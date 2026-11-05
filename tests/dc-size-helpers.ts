// Generated synthetic bytes only: no downloaded pages or response fixtures.
export const dcSizeCases = [
  { source: 'dc_softbank', bytes: 139 * 1024, type: 'text/html' },
  { source: 'dc_sakura', bytes: 186 * 1024, type: 'application/pdf' },
  { source: 'dc_edgeconnex', bytes: 162 * 1024, type: 'text/html' },
] as const;
export const dcSizeTitle = 'Synthetic disclosure';
export const dcSizeMarker = 'SYNTHETIC_BODY_MUST_NOT_BE_RETAINED';
export function dcSizeBody(bytes: number, type: string) {
  // Invalid UTF-8 in PDFs proves that their contents never enter the HTML decoder.
  const body = new Uint8Array(bytes).fill(type === 'application/pdf' ? 255 : 120);
  body.set(
    new TextEncoder().encode(
      type === 'application/pdf'
        ? '%PDF-1.7\n' + dcSizeMarker
        : `<title>${dcSizeTitle}</title><p>${dcSizeMarker}</p>`,
    ),
  );
  return body;
}
