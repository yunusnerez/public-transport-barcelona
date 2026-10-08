// Minimal GTFS-RT reader for vehicle positions. Wire types only; unknown fields are skipped.

function readVarint(buf, i) {
  let shift = 0;
  let n = 0;
  while (i < buf.length) {
    const b = buf[i++];
    n += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return [n, i];
    shift += 7;
    if (shift > 35) break;
  }
  throw new Error("truncated varint");
}

function readFields(buf) {
  const fields = [];
  let i = 0;
  while (i < buf.length) {
    let key;
    [key, i] = readVarint(buf, i);
    const field = key >> 3;
    const wt = key & 7;
    if (wt === 0) {
      let v;
      [v, i] = readVarint(buf, i);
      fields.push([field, "varint", v]);
    } else if (wt === 1) {
      if (i + 8 > buf.length) break;
      const view = new DataView(buf.buffer, buf.byteOffset + i, 8);
      fields.push([field, "f64", view.getFloat64(0, true)]);
      i += 8;
    } else if (wt === 2) {
      let len;
      [len, i] = readVarint(buf, i);
      const start = i;
      i += len;
      if (i > buf.length) break;
      fields.push([field, "bytes", buf.subarray(start, i)]);
    } else if (wt === 5) {
      if (i + 4 > buf.length) break;
      const view = new DataView(buf.buffer, buf.byteOffset + i, 4);
      fields.push([field, "f32", view.getFloat32(0, true)]);
      i += 4;
    } else {
      break;
    }
  }
  return fields;
}

function asString(chunk) {
  return new TextDecoder().decode(chunk);
}

function message(chunk) {
  return readFields(chunk);
}

function field(fields, n) {
  return fields.find((f) => f[0] === n) || null;
}

function fieldsNamed(fields, n) {
  return fields.filter((f) => f[0] === n);
}

export function decodeVehiclePositions(buffer, stopCoords = null) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const root = readFields(bytes);
  let feedTimestamp = null;
  const header = field(root, 1);
  if (header && header[1] === "bytes") {
    const ts = field(message(header[2]), 3);
    if (ts && ts[1] === "varint") feedTimestamp = ts[2];
  }
  const vehicles = [];
  for (const entity of fieldsNamed(root, 2)) {
    if (entity[1] !== "bytes") continue;
    const ent = message(entity[2]);
    const deleted = field(ent, 2);
    if (deleted && deleted[1] === "varint" && deleted[2] === 1) continue;
    const vehicleField = field(ent, 4);
    if (vehicleField && vehicleField[1] === "bytes") {
      const vp = message(vehicleField[2]);
      const parsed = readVehicle(vp);
      if (parsed) {
        const idField = field(ent, 1);
        if (!parsed.vehicleId && idField && idField[1] === "bytes") parsed.vehicleId = asString(idField[2]);
        if (!parsed.timestamp && feedTimestamp) parsed.timestamp = feedTimestamp;
        vehicles.push(parsed);
        continue;
      }
    }
    const tuField = field(ent, 3);
    if (tuField && tuField[1] === "bytes" && stopCoords) {
      const tu = message(tuField[2]);
      const idField = field(ent, 1);
      const entId = idField && idField[1] === "bytes" ? asString(idField[2]) : "";
      const parsed = readTripUpdateVehicle(tu, entId, feedTimestamp, stopCoords);
      if (parsed) {
        vehicles.push(parsed);
      }
    }
  }
  return { timestamp: feedTimestamp, vehicles };
}

function readTripUpdateVehicle(tu, entId, feedTimestamp, stopCoords) {
  const tripField = field(tu, 1);
  let tripId = "";
  let routeId = "";
  if (tripField && tripField[1] === "bytes") {
    const trip = message(tripField[2]);
    const tid = field(trip, 1);
    const rid = field(trip, 5);
    if (tid && tid[1] === "bytes") tripId = asString(tid[2]);
    if (rid && rid[1] === "bytes") routeId = asString(rid[2]);
  }
  const vehField = field(tu, 3);
  let vehicleId = entId;
  let label = "";
  if (vehField && vehField[1] === "bytes") {
    const vd = message(vehField[2]);
    const id = field(vd, 1);
    const lab = field(vd, 2);
    if (id && id[1] === "bytes") vehicleId = asString(id[2]) || entId;
    if (lab && lab[1] === "bytes") label = asString(lab[2]);
  }
  const tsField = field(tu, 4);
  const ts = tsField && tsField[1] === "varint" ? tsField[2] : feedTimestamp || Math.floor(Date.now() / 1000);

  const stuFields = fieldsNamed(tu, 2);
  const stopUpdates = [];
  for (const stuF of stuFields) {
    if (stuF[1] !== "bytes") continue;
    const stu = message(stuF[2]);
    const stopIdField = field(stu, 4);
    if (!stopIdField || stopIdField[1] !== "bytes") continue;
    const stopId = asString(stopIdField[2]);
    const arrField = field(stu, 2);
    let arrTime = null;
    if (arrField && arrField[1] === "bytes") {
      const arr = message(arrField[2]);
      const timeF = field(arr, 2);
      if (timeF && timeF[1] === "varint") arrTime = timeF[2];
    }
    const depField = field(stu, 3);
    let depTime = null;
    if (depField && depField[1] === "bytes") {
      const dep = message(depField[2]);
      const timeF = field(dep, 2);
      if (timeF && timeF[1] === "varint") depTime = timeF[2];
    }
    const time = arrTime || depTime;
    if (time) stopUpdates.push({ stopId, time });
  }

  if (!stopUpdates.length || !stopCoords) return null;
  stopUpdates.sort((a, b) => a.time - b.time);

  const now = ts;
  const nextIdx = stopUpdates.findIndex((s) => s.time > now);
  let coords = null;
  let bearing = null;
  let stopId = "";

  if (nextIdx === 0) {
    coords = stopCoords[stopUpdates[0].stopId];
    stopId = stopUpdates[0].stopId;
  } else if (nextIdx > 0) {
    const prev = stopUpdates[nextIdx - 1];
    const next = stopUpdates[nextIdx];
    stopId = next.stopId;
    const pCoord = stopCoords[prev.stopId];
    const nCoord = stopCoords[next.stopId];
    if (pCoord && nCoord) {
      const duration = Math.max(1, next.time - prev.time);
      const elapsed = Math.max(0, Math.min(duration, now - prev.time));
      const frac = elapsed / duration;
      coords = [
        pCoord[0] + (nCoord[0] - pCoord[0]) * frac,
        pCoord[1] + (nCoord[1] - pCoord[1]) * frac,
      ];
      const rad = Math.PI / 180;
      const dLon = (nCoord[0] - pCoord[0]) * rad;
      const lat1 = pCoord[1] * rad;
      const lat2 = nCoord[1] * rad;
      const y = Math.sin(dLon) * Math.cos(lat2);
      const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
      bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    } else if (nCoord) {
      coords = nCoord;
    }
  } else if (stopUpdates.length > 0) {
    const last = stopUpdates[stopUpdates.length - 1];
    if (now - last.time < 90) {
      coords = stopCoords[last.stopId];
      stopId = last.stopId;
    }
  }

  if (!coords) return null;
  const [lon, lat] = coords;
  if (lat < 40 || lat > 43.8 || lon < 0 || lon > 3.6) return null;

  return {
    tripId,
    routeId,
    lat,
    lon,
    bearing: Number.isFinite(bearing) ? bearing : null,
    timestamp: ts,
    stopId,
    vehicleId,
    label,
  };
}

function readVehicle(vp) {
  const tripField = field(vp, 1);
  let tripId = "";
  let routeId = "";
  if (tripField && tripField[1] === "bytes") {
    const trip = message(tripField[2]);
    const tid = field(trip, 1);
    const rid = field(trip, 2);
    if (tid && tid[1] === "bytes") tripId = asString(tid[2]);
    if (rid && rid[1] === "bytes") routeId = asString(rid[2]);
    const rel = field(trip, 6);
    if (rel && rel[1] === "varint" && rel[2] === 3) return null;
  }
  const posField = field(vp, 2);
  if (!posField || posField[1] !== "bytes") return null;
  const pos = message(posField[2]);
  const latF = field(pos, 1);
  const lonF = field(pos, 2);
  const bearF = field(pos, 3);
  if (!latF || latF[1] !== "f32" || !lonF || lonF[1] !== "f32") return null;
  const lat = latF[2];
  const lon = lonF[2];
  if (lat < 40 || lat > 43.8 || lon < 0 || lon > 3.6) return null;
  const ts = field(vp, 5);
  const stop = field(vp, 7);
  const veh = field(vp, 8);
  let vehicleId = "";
  let label = "";
  if (veh && veh[1] === "bytes") {
    const vd = message(veh[2]);
    const id = field(vd, 1);
    const lab = field(vd, 2);
    if (id && id[1] === "bytes") vehicleId = asString(id[2]);
    if (lab && lab[1] === "bytes") label = asString(lab[2]);
  }
  return {
    tripId,
    routeId,
    lat,
    lon,
    bearing: bearF && bearF[1] === "f32" ? bearF[2] : null,
    timestamp: ts && ts[1] === "varint" ? ts[2] : null,
    stopId: stop && stop[1] === "bytes" ? asString(stop[2]) : "",
    vehicleId,
    label,
  };
}

export async function maybeGunzip(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  if (typeof DecompressionStream === "undefined") return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
