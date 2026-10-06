// Google encoded polyline, 1e-5 degrees. Points are [lon, lat].

export function encodePolyline(points, precision = 5) {
  const factor = 10 ** precision;
  let out = "";
  let plat = 0;
  let plon = 0;
  for (const [lon, lat] of points) {
    const ilat = Math.round(lat * factor);
    const ilon = Math.round(lon * factor);
    out += encodeSigned(ilat - plat);
    out += encodeSigned(ilon - plon);
    plat = ilat;
    plon = ilon;
  }
  return out;
}

export function decodePolyline(str, precision = 5) {
  const factor = 10 ** precision;
  const points = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  while (i < str.length) {
    const dlat = decodeSigned(str, i);
    i = dlat.i;
    lat += dlat.n;
    const dlon = decodeSigned(str, i);
    i = dlon.i;
    lon += dlon.n;
    points.push([lon / factor, lat / factor]);
  }
  return points;
}

function encodeSigned(n) {
  let v = n < 0 ? ~(n << 1) : n << 1;
  let out = "";
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}

function decodeSigned(str, i) {
  let shift = 0;
  let result = 0;
  let byte;
  do {
    byte = str.charCodeAt(i++) - 63;
    result |= (byte & 0x1f) << shift;
    shift += 5;
  } while (byte >= 0x20);
  const n = result & 1 ? ~(result >> 1) : result >> 1;
  return { n, i };
}
