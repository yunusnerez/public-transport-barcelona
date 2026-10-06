// Points are [lon, lat].

export function haversineMeters(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const lat1 = a[1] * rad;
  const lat2 = b[1] * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDeg(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * rad) * Math.cos(b[1] * rad);
  const x = Math.cos(a[1] * rad) * Math.sin(b[1] * rad)
    - Math.sin(a[1] * rad) * Math.cos(b[1] * rad) * Math.cos((b[0] - a[0]) * rad);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

export function shapeMetrics(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + haversineMeters(points[i - 1], points[i]));
  }
  return { points, cum };
}

export function pointAt(metrics, dist) {
  const { points, cum } = metrics;
  if (!points.length) return null;
  if (points.length === 1 || dist <= 0) {
    const b = points[Math.min(1, points.length - 1)];
    return { lon: points[0][0], lat: points[0][1], bearing: bearingDeg(points[0], b) };
  }
  const last = cum.length - 1;
  if (dist >= cum[last]) {
    return {
      lon: points[last][0],
      lat: points[last][1],
      bearing: bearingDeg(points[last - 1], points[last]),
    };
  }
  let lo = 0;
  let hi = last;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= dist) lo = mid;
    else hi = mid;
  }
  const span = cum[hi] - cum[lo] || 1;
  const f = (dist - cum[lo]) / span;
  const a = points[lo];
  const b = points[hi];
  return {
    lon: a[0] + (b[0] - a[0]) * f,
    lat: a[1] + (b[1] - a[1]) * f,
    bearing: bearingDeg(a, b),
  };
}
