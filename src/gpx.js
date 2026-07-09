// GPX 1.1 serializer + browser download. Track points carry elevation so
// COROS/Gaia get a real profile, not a flat line.

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function toGPX(coords, name = 'Route') {
  const pts = coords
    .map(
      (c) =>
        `      <trkpt lat="${c[1].toFixed(6)}" lon="${c[0].toFixed(6)}">` +
        (c[2] != null ? `<ele>${c[2].toFixed(1)}</ele>` : '') +
        `</trkpt>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="route-builder" xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata><name>${esc(name)}</name></metadata>
  <trk>
    <name>${esc(name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

export function downloadGPX(coords, name) {
  const safe = (name || 'route').trim() || 'route';
  const blob = new Blob([toGPX(coords, safe)], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${safe.replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').toLowerCase()}.gpx`;
  a.click();
  URL.revokeObjectURL(a.href);
}
