// CommonJS ledger helpers.
'use strict';

const CENTS_RE = /^-?(\d+)(\.\d{2})?$/;

/**
 * Parse a decimal string into integer cents.
 * Accepted shape: optional '-', one or more digits, optional '.' + exactly two digits.
 * Throws on invalid input or when the resulting cents value is not a safe integer.
 */
function parseCents(text) {
  if (typeof text !== 'string') {
    throw new TypeError('parseCents expects a string');
  }
  const m = CENTS_RE.exec(text);
  if (!m) {
    throw new Error(`Invalid cents string: ${JSON.stringify(text)}`);
  }
  const negative = text[0] === '-';
  const intPart = m[1];
  const decPart = m[2] ? m[2].slice(1) : '00';
  const cents =
    (Number(intPart) * 100 + Number(decPart)) * (negative ? -1 : 1);
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`Cents value is not a safe integer: ${text}`);
  }
  return cents;
}

/**
 * Sum safe integer cents per category. Rows are {category, amountCents}.
 * Negative amounts are included normally.
 * Throws on malformed rows, non-safe-integer amounts, or unsafe running sums.
 */
function groupTotals(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('groupTotals expects an array of rows');
  }
  const totals = {};
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      throw new TypeError('groupTotals row must be an object');
    }
    const { category, amountCents } = row;
    if (typeof category !== 'string') {
      throw new TypeError('groupTotals row category must be a string');
    }
    if (
      !Number.isInteger(amountCents) ||
      !Number.isSafeInteger(amountCents)
    ) {
      throw new TypeError(
        'groupTotals row amountCents must be a safe integer'
      );
    }
    const current = Object.prototype.hasOwnProperty.call(totals, category)
      ? totals[category]
      : 0;
    const next = current + amountCents;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError(`Unsafe total for category: ${category}`);
    }
    totals[category] = next;
  }
  return totals;
}

/**
 * Return first occurrences of each value, in original order.
 * Falsy values (0, false, '', null, undefined, NaN) are preserved.
 */
function stableUnique(values) {
  if (!Array.isArray(values)) {
    throw new TypeError('stableUnique expects an array');
  }
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

module.exports = { parseCents, groupTotals, stableUnique };
