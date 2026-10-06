import assert from "node:assert/strict";
import test from "node:test";
import { vehiclesFromIbus } from "../worker/src/ibus.js";
import { encodePolyline } from "../worker/src/polyline.js";

const now = 1_700_000_000;
const pattern = {
  dest: "Zona Universitaria",
  direction: 0,
  shape: encodePolyline([[2.15, 41.37], [2.17, 41.37]]),
  stops: [
    ["100", 0, 0],
    ["200", 800, 400],
  ],
  samples: [],
};
const index = {
  alias: { H6: "H6", "206": "H6", "2.206.2995": "H6" },
  lines: { H6: [pattern] },
};

test("a stop that is not on the pattern does not become a vehicle", () => {
  const vehicles = vehiclesFromIbus([payload("9999", "H6", 60)], index, now);
  assert.deepEqual(vehicles, []);
});

test("a known stop becomes an estimated point, never GPS", () => {
  const vehicles = vehiclesFromIbus([payload("200", "206", now + 120)], index, now);
  assert.equal(vehicles.length, 1);
  assert.equal(vehicles[0].source, "estimated");
  assert.equal(vehicles[0].operator, "tmb");
  assert.equal(vehicles[0].line, "H6");
  assert.equal(vehicles[0].id, "tmb:8841");
  assert.ok(vehicles[0].lat > 41 && vehicles[0].lat < 42);
  assert.ok(vehicles[0].lon > 2 && vehicles[0].lon < 3);
});

test("an ETA that cannot sit on the shape is dropped", () => {
  const vehicles = vehiclesFromIbus([payload("200", "H6", now + 50 * 60)], index, now);
  assert.deepEqual(vehicles, []);
});

function payload(stopCode, lineCode, arrival) {
  return {
    timestamp: now,
    data: {
      parades: [{
        codi_parada: stopCode,
        linies_trajectes: [{
          codi_linia: lineCode,
          desti_trajecte: "Zona Universitària",
          id_sentit: 1,
          propers_busos: [{ id_bus: "8841", temps_arribada: arrival }],
        }],
      }],
    },
  };
}
