import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { decodeVehiclePositions, maybeGunzip } from "../worker/src/gtfsrt.js";

test("protobuf vehicle positions keep GPS and drop canceled or out-of-range rows", async () => {
  const raw = feed([
    vehicleEntity({
      id: "e1",
      tripId: "svc|2798",
      lat: 41.39,
      lon: 2.17,
      bearing: 180,
      timestamp: 1791316803,
      vehicleId: "V1",
    }),
    vehicleEntity({
      id: "e2",
      tripId: "svc|gone",
      lat: 41.4,
      lon: 2.18,
      timestamp: 1791316803,
      vehicleId: "V2",
      canceled: true,
    }),
    vehicleEntity({
      id: "e3",
      tripId: "svc|far",
      lat: 10,
      lon: 2.18,
      timestamp: 1791316803,
      vehicleId: "V3",
    }),
  ]);
  const decoded = decodeVehiclePositions(await maybeGunzip(gzipSync(raw)));
  assert.equal(decoded.timestamp, 1791316803);
  assert.equal(decoded.vehicles.length, 1);
  const vehicle = decoded.vehicles[0];
  assert.equal(vehicle.tripId, "svc|2798");
  assert.equal(vehicle.vehicleId, "V1");
  assert.equal(vehicle.timestamp, 1791316803);
  assert.ok(Math.abs(vehicle.lat - 41.39) < 1e-5);
  assert.ok(Math.abs(vehicle.lon - 2.17) < 1e-5);
  assert.ok(Math.abs(vehicle.bearing - 180) < 0.1);
});

test("TripUpdate entities decode into vehicle positions with interpolated stop coordinates", () => {
  const now = 1791316803;
  const stopCoords = {
    "STOP_A": [2.15, 41.38],
    "STOP_B": [2.16, 41.39],
  };

  const tripUpdateBytes = [
    // TripDescriptor: tripId="TRAM_TRIP_1", routeId="T3"
    ...bytesField(1, [
      ...strField(1, "TRAM_TRIP_1"),
      ...strField(5, "T3"),
    ]),
    // VehicleDescriptor: id="TRAM_VEH_1"
    ...bytesField(3, [
      ...strField(1, "TRAM_VEH_1"),
    ]),
    // StopTimeUpdate 1: stopId="STOP_A", departure time = now - 30
    ...bytesField(2, [
      ...strField(4, "STOP_A"),
      ...bytesField(3, varintField(2, now - 30)),
    ]),
    // StopTimeUpdate 2: stopId="STOP_B", arrival time = now + 30
    ...bytesField(2, [
      ...strField(4, "STOP_B"),
      ...bytesField(2, varintField(2, now + 30)),
    ]),
  ];

  const entity = [
    ...strField(1, "ent_tu_1"),
    ...bytesField(3, tripUpdateBytes),
  ];

  const raw = feed([entity]);
  const decoded = decodeVehiclePositions(raw, stopCoords);
  assert.equal(decoded.vehicles.length, 1);
  const v = decoded.vehicles[0];
  assert.equal(v.tripId, "TRAM_TRIP_1");
  assert.equal(v.routeId, "T3");
  assert.equal(v.vehicleId, "TRAM_VEH_1");
  // Progress is halfway between STOP_A and STOP_B (fraction 0.5)
  assert.ok(Math.abs(v.lon - 2.155) < 1e-4);
  assert.ok(Math.abs(v.lat - 41.385) < 1e-4);
  assert.ok(Number.isFinite(v.bearing));
});

function varint(n) {
  const out = [];
  let value = n;
  while (value > 0x7f) {
    out.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  out.push(value & 0x7f);
  return out;
}

function tag(field, wt) {
  return varint((field << 3) | wt);
}

function bytesField(field, data) {
  const bytes = Array.from(data);
  return [...tag(field, 2), ...varint(bytes.length), ...bytes];
}

function strField(field, text) {
  return bytesField(field, new TextEncoder().encode(text));
}

function f32Field(field, value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setFloat32(0, value, true);
  return [...tag(field, 5), ...bytes];
}

function varintField(field, n) {
  return [...tag(field, 0), ...varint(n)];
}

function feed(entities) {
  const nums = [...bytesField(1, varintField(3, 1791316803))];
  for (const entity of entities) nums.push(...bytesField(2, entity));
  return Uint8Array.from(nums);
}

function vehicleEntity({ id, tripId, lat, lon, bearing, timestamp, vehicleId, canceled }) {
  const trip = [
    ...strField(1, tripId),
    ...(canceled ? varintField(6, 3) : varintField(4, 0)),
  ];
  const pos = [
    ...f32Field(1, lat),
    ...f32Field(2, lon),
    ...(bearing == null ? [] : f32Field(3, bearing)),
  ];
  const vp = [
    ...bytesField(1, trip),
    ...bytesField(2, pos),
    ...varintField(5, timestamp),
    ...bytesField(8, strField(1, vehicleId)),
  ];
  return [...strField(1, id), ...bytesField(4, vp)];
}
