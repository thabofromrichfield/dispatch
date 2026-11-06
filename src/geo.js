// Geometry used for geofence decisions. A wrong answer here raises false "left site" alerts,
// so these stay pure and are covered by test/units.test.js.

// Ray casting. Points are [lat, lng], matching Leaflet and the stored site coordinates.
function pointInPolygon(point, polygon = []) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i],
      [yj, xj] = polygon[j];
    if (xi > point[1] !== xj > point[1] && point[0] < ((yj - yi) * (point[1] - xi)) / (xj - xi + 1e-12) + yi)
      inside = !inside;
  }
  return inside;
}

// Distance from the point to the nearest polygon edge, in metres.
function pointNearPolygon(point, polygon = [], toleranceMeters = 0) {
  if (!toleranceMeters || polygon.length < 2) return false;
  const latScale = 111320,
    lonScale = 111320 * Math.cos((point[0] * Math.PI) / 180),
    x = point[1] * lonScale,
    y = point[0] * latScale;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const ax = polygon[j][1] * lonScale,
      ay = polygon[j][0] * latScale,
      bx = polygon[i][1] * lonScale,
      by = polygon[i][0] * latScale,
      dx = bx - ax,
      dy = by - ay,
      t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1))),
      dist = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    if (dist <= toleranceMeters) return true;
  }
  return false;
}

module.exports = { pointInPolygon, pointNearPolygon };
