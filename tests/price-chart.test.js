const test = require("node:test");
const assert = require("node:assert/strict");
const {processCandles} = require("../chart.js");

const DAY = 86400000;
const today = Date.UTC(2026, 10, 20);
const now = today + 12 * 60 * 60 * 1000;

function candles(count) {
  return Array.from({length: count}, (_, i) => {
    const close = 100 + i;
    return [today - (count - 1 - i) * DAY, close, close + 2, close - 2, close, 10];
  });
}

test("uses 30 completed UTC days and a rolling 200-day average", () => {
  const result = processCandles(candles(261), now);
  assert.equal(result.points.length, 30);
  assert.deepEqual(result.points[0], [today - 30 * DAY, 330, 230.5]);
  assert.deepEqual(result.points.at(-1), [today - DAY, 359, 259.5]);
  assert.equal(result.high, 362);
});

test("five-year extremes exclude older candles and include the cutoff day", () => {
  const data = candles(2000);
  const cutoff = Date.UTC(2021, 10, 20);
  const before = data.find(c => c[0] === cutoff - DAY);
  const boundary = data.find(c => c[0] === cutoff);
  before[2] = 100000;
  before[3] = 0.001;
  boundary[2] = 9999;
  boundary[3] = 1;
  const result = processCandles(data, now);
  assert.equal(result.high, 9999);
  assert.equal(result.low, 1);
});

test("keeps the calendar window when a recent day is missing", () => {
  const data = candles(261).filter(c => c[0] !== today - 10 * DAY);
  const result = processCandles(data, now);
  assert.equal(result.points.length, 29);
  assert.equal(result.points[0][0], today - 30 * DAY);
  assert.equal(result.points.at(-1)[0], today - DAY);
});

test("does not claim an MA200 without 200 consecutive daily candles", () => {
  const short = processCandles(candles(199), now);
  assert.ok(short.points.every(p => p[2] === null));
  const gap = processCandles(candles(261).filter(c => c[0] !== today - 50 * DAY), now);
  assert.ok(gap.points.every(p => p[2] === null));
  const recovered = processCandles(candles(261).filter(c => c[0] !== today - 201 * DAY), now);
  assert.equal(recovered.points.at(-2)[2], null);
  assert.equal(recovered.points.at(-1)[2], 259.5);
});

test("omits future candles from the chart and five-year range", () => {
  const data = candles(261);
  data.push([today + DAY, 100000, 100001, 99999, 100000, 10]);
  const result = processCandles(data, now);
  assert.equal(result.points.at(-1)[0], today - DAY);
  assert.equal(result.high, 362);
});

test("rejects malformed, unordered or duplicate daily candles", () => {
  const invalid = candles(3);
  invalid[1][4] = "not-a-price";
  assert.throws(() => processCandles(invalid, now), /Invalid daily candle values/);
  const duplicate = candles(3);
  duplicate[1][0] = duplicate[0][0];
  assert.throws(() => processCandles(duplicate, now), /Invalid daily candle values/);
  const misaligned = candles(3);
  misaligned[1][0] += 1;
  assert.throws(() => processCandles(misaligned, now), /Invalid daily candle values/);
  const inverted = candles(3);
  inverted[1][3] = inverted[1][2] + 1;
  assert.throws(() => processCandles(inverted, now), /Invalid daily candle values/);
});
