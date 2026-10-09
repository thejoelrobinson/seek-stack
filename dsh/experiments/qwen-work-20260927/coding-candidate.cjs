"use strict";

const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
const AMOUNT_RE = /^-?\d+(\.\d{2})?$/;

function parseCents(text) {
  if (typeof text !== "string" || !AMOUNT_RE.test(text)) {
    throw new TypeError('parseCents: expected a string like "12", "-3.05", or "0.01"');
  }
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const dot = unsigned.indexOf(".");
  const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fracPart = dot === -1 ? "00" : unsigned.slice(dot + 1);
  let cents = BigInt(intPart) * 100n + BigInt(fracPart);
  if (negative) cents = -cents;
  if (cents < -MAX_SAFE_CENTS || cents > MAX_SAFE_CENTS) {
    throw new RangeError("parseCents: amount is not a safe integer number of cents");
  }
  return Number(cents);
}

function groupTotals(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError("groupTotals: expected an array of {category, amountCents} rows");
  }
  const totals = new Map();
  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new TypeError("groupTotals: each row must be a {category, amountCents} object");
    }
    if (row.category === undefined || row.category === null) {
      throw new TypeError("groupTotals: each row must have a category");
    }
    if (!Number.isSafeInteger(row.amountCents)) {
      throw new RangeError("groupTotals: amountCents must be a safe integer");
    }
    const key = String(row.category);
    const sum = (totals.get(key) ?? 0n) + BigInt(row.amountCents);
    if (sum < -MAX_SAFE_CENTS || sum > MAX_SAFE_CENTS) {
      throw new RangeError("groupTotals: total for category " + JSON.stringify(row.category) + " is not a safe integer");
    }
    totals.set(key, sum);
  }
  const result = {};
  for (const [key, sum] of totals) {
    result[key] = Number(sum);
  }
  return result;
}

function stableUnique(values) {
  if (!Array.isArray(values)) {
    throw new TypeError("stableUnique: expected an array");
  }
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

module.exports = { parseCents, groupTotals, stableUnique };
